"""routes.py 的非 LLM 部分：health endpoint + WebSocket 連線握手 + main 啟動。"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient


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
        with patch("app.main._get_stream_model", called):

            async def _run() -> None:
                async with lifespan(app):
                    pass

            asyncio.run(_run())

        called.assert_called_once()
