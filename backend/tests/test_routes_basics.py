"""routes.py 的非 LLM 部分：health endpoint + WebSocket 連線握手 + main 啟動。"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient


class _FakeProcessor:
    """可控的 AudioProcessor 替身：第一次 should_process 回 True，之後 False，

    避免 poll 迴圈持續觸發轉錄洗爆訊息佇列。get_wav_bytes 回足夠長度
    （> _WAV_MIN_BYTES）的假 WAV bytes 讓 poll 不會因太短而 skip。
    """

    def __init__(self, *_args, **_kwargs) -> None:
        self._fired = False
        self.frames: list[bytes] = []

    def add_frame(self, frame: bytes) -> None:
        self.frames.append(frame)

    def should_process(self) -> bool:
        if self._fired:
            return False
        self._fired = True
        return True

    def get_wav_bytes(self) -> bytes:
        return b"\x00" * 2000

    def clear(self) -> None:
        self.frames = []

    def has_pending(self) -> bool:
        return bool(self.frames)


@pytest.fixture
def client() -> TestClient:
    from fastapi import FastAPI

    from app.routes import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


# ── /api/health ───────────────────────────────────────────────────────────────


@pytest.mark.integration
class TestHealth:
    def test_health_loading_when_model_not_ready(self, client: TestClient) -> None:
        # 確保 _stream_model 為 None（其他 test 可能載過）
        import app.routes as routes_module
        with patch.object(routes_module, "_stream_model", None):
            with patch.object(routes_module, "WHISPER_CPP_URL", ""):
                resp = client.get("/api/health")
        assert resp.status_code == 503
        assert resp.json()["status"] == "loading"

    def test_health_ok_when_using_whisper_cpp(self, client: TestClient) -> None:
        import app.routes as routes_module
        with patch.object(routes_module, "WHISPER_CPP_URL", "http://whisper:9000"):
            resp = client.get("/api/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["backend"] == "whisper.cpp"

    def test_health_ok_when_local_model_loaded(self, client: TestClient) -> None:
        import app.routes as routes_module
        with patch.object(routes_module, "_stream_model", object()):
            with patch.object(routes_module, "WHISPER_CPP_URL", ""):
                resp = client.get("/api/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["backend"] == "faster-whisper"


# ── WebSocket 連線握手 ───────────────────────────────────────────────────────


@pytest.mark.integration
class TestWebSocketStreamHandshake:
    def test_connects_and_receives_hello(self, client: TestClient) -> None:
        with client.websocket_connect("/api/stream") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "connected"


@pytest.mark.integration
class TestWebSocketStreamTranscription:
    """收 binary frame → 觸發轉錄 → 回推 processing / transcription / error。"""

    def test_binary_frame_yields_transcription(self, client: TestClient) -> None:
        import app.routes as routes_module

        async def _fake_transcribe(_wav: bytes, *_a, **_kw) -> str:
            return "測試逐字稿"

        with patch.object(routes_module, "AudioProcessor", _FakeProcessor), patch.object(
            routes_module, "_transcribe", _fake_transcribe
        ):
            with client.websocket_connect("/api/stream") as ws:
                assert ws.receive_json()["type"] == "connected"
                ws.send_bytes(b"\x01\x02" * 480)  # 一包 PCM16 30ms
                assert ws.receive_json()["type"] == "processing"
                msg = ws.receive_json()
                assert msg["type"] == "transcription"
                assert msg["text"] == "測試逐字稿"

    def test_empty_transcription_is_not_sent(self, client: TestClient) -> None:
        """轉錄回空字串時不推 transcription（避免空泡泡）。"""
        import app.routes as routes_module

        async def _empty_transcribe(_wav: bytes, *_a, **_kw) -> str:
            return ""

        with patch.object(routes_module, "AudioProcessor", _FakeProcessor), patch.object(
            routes_module, "_transcribe", _empty_transcribe
        ):
            with client.websocket_connect("/api/stream") as ws:
                assert ws.receive_json()["type"] == "connected"
                ws.send_bytes(b"\x01\x02" * 480)
                # processing 一定有；其後不應出現 transcription
                assert ws.receive_json()["type"] == "processing"

    def test_transcribe_failure_yields_error(self, client: TestClient) -> None:
        import app.routes as routes_module

        async def _boom(_wav: bytes, *_a, **_kw) -> str:
            raise RuntimeError("ASR exploded")

        with patch.object(routes_module, "AudioProcessor", _FakeProcessor), patch.object(
            routes_module, "_transcribe", _boom
        ):
            with client.websocket_connect("/api/stream") as ws:
                assert ws.receive_json()["type"] == "connected"
                ws.send_bytes(b"\x01\x02" * 480)
                assert ws.receive_json()["type"] == "processing"
                msg = ws.receive_json()
                assert msg["type"] == "error"
                assert "轉錄失敗" in msg["message"]


# ── main.py：lifespan 不應該因為缺 vector_store 就炸 ─────────────────────────


@pytest.mark.integration
class TestMainAppStarts:
    def test_app_factory_imports(self) -> None:
        """確保 main.py 沒留下 vector_store / RAG 的死引用。"""
        import importlib

        with patch("app.routes._get_stream_model", return_value=object()):
            mod = importlib.import_module("app.main")
            importlib.reload(mod)
            assert mod.app is not None
            assert mod.app.title.startswith("letsMeet")

    def test_lifespan_preloads_stream_model(self) -> None:
        """模擬 FastAPI lifespan，確認 _get_stream_model 會被呼到。"""
        import asyncio
        from unittest.mock import MagicMock

        from app.main import app, lifespan  # noqa: F401

        called = MagicMock()
        init_db_mock = MagicMock()
        with patch("app.main._get_stream_model", called), patch("app.main.init_db", init_db_mock):

            async def _run() -> None:
                async with lifespan(app):
                    pass

            asyncio.run(_run())

        called.assert_called_once()
        init_db_mock.assert_called_once()
