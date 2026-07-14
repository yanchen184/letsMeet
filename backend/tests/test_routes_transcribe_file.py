"""POST /api/transcribe-file：上傳音檔批次轉錄（SSE 逐段回傳）。

真模型不載入：faster-whisper 路徑 mock `_get_stream_model` + `_iter_file_segments`，
單段路徑（whisper.cpp）mock `_transcribe` 與 `_ffmpeg_to_wav16k`。
"""

from __future__ import annotations

import json
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


def _parse_sse(body: str) -> list:
    """把 SSE body 拆成 payload 清單（不含 [DONE]）。"""
    events = []
    for block in body.split("\n\n"):
        for line in block.split("\n"):
            if not line.startswith("data: "):
                continue
            payload = line[len("data: "):]
            if payload == "[DONE]":
                continue
            events.append(json.loads(payload))
    return events


@pytest.mark.integration
class TestTranscribeFile:
    def test_empty_body_returns_422(self, client: TestClient) -> None:
        resp = client.post("/api/transcribe-file", content=b"")
        assert resp.status_code == 422
        assert "不可為空" in resp.json()["error"]

    def test_oversized_body_returns_413(self, client: TestClient) -> None:
        import app.routes as routes_module

        with patch.object(routes_module, "UPLOAD_MAX_BYTES", 10):
            resp = client.post("/api/transcribe-file", content=b"x" * 11)
        assert resp.status_code == 413
        assert "上限" in resp.json()["error"]

    def test_faster_whisper_streams_segments(self, client: TestClient) -> None:
        import app.routes as routes_module

        def _fake_segments(_model, _data, _language):
            yield 0.0, 2.5, "第一段"
            yield 2.5, 5.0, "第二段"
            yield 5.0, 6.0, ""  # 空段要被濾掉

        with (
            patch.object(routes_module, "WHISPER_CPP_URL", ""),
            patch.object(routes_module, "ASR_BACKEND", "faster-whisper"),
            patch.object(routes_module, "_get_stream_model", return_value=object()),
            patch.object(routes_module, "_iter_file_segments", _fake_segments),
        ):
            resp = client.post("/api/transcribe-file", content=b"fake-audio-bytes")

        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        events = _parse_sse(resp.text)
        segs = [e for e in events if e["type"] == "segment"]
        assert [s["text"] for s in segs] == ["第一段", "第二段"]
        assert segs[0]["t"] == 0.0
        assert segs[1]["t"] == 2.5
        done = [e for e in events if e["type"] == "done"]
        assert done and done[0]["segments"] == 2

    def test_worker_exception_yields_error_event(self, client: TestClient) -> None:
        import app.routes as routes_module

        def _boom(_model, _data, _language):
            raise RuntimeError("decode blew up")
            yield  # pragma: no cover - 讓函式是 generator

        with (
            patch.object(routes_module, "WHISPER_CPP_URL", ""),
            patch.object(routes_module, "ASR_BACKEND", "faster-whisper"),
            patch.object(routes_module, "_get_stream_model", return_value=object()),
            patch.object(routes_module, "_iter_file_segments", _boom),
        ):
            resp = client.post("/api/transcribe-file", content=b"fake-audio-bytes")

        assert resp.status_code == 200
        events = _parse_sse(resp.text)
        assert any(e["type"] == "error" for e in events)
        assert not any(e["type"] == "done" for e in events)

    def test_whisper_cpp_single_segment_path(self, client: TestClient) -> None:
        import app.routes as routes_module

        async def _fake_transcribe(_wav: bytes, *_a, **_kw) -> str:
            return "整檔一次轉出來的文字"

        with (
            patch.object(routes_module, "WHISPER_CPP_URL", "http://whisper:9000"),
            patch.object(routes_module, "_ffmpeg_to_wav16k", return_value=b"RIFFfake"),
            patch.object(routes_module, "_transcribe", _fake_transcribe),
        ):
            resp = client.post("/api/transcribe-file", content=b"fake-mp3-bytes")

        assert resp.status_code == 200
        events = _parse_sse(resp.text)
        segs = [e for e in events if e["type"] == "segment"]
        assert len(segs) == 1
        assert segs[0]["text"] == "整檔一次轉出來的文字"
        assert segs[0]["t"] == 0.0
        done = [e for e in events if e["type"] == "done"]
        assert done and done[0]["segments"] == 1

    def test_ffmpeg_decode_failure_yields_error_event(self, client: TestClient) -> None:
        import app.routes as routes_module

        def _bad_ffmpeg(_data: bytes) -> bytes:
            raise RuntimeError("ffmpeg 解碼失敗: bad file")

        with (
            patch.object(routes_module, "WHISPER_CPP_URL", "http://whisper:9000"),
            patch.object(routes_module, "_ffmpeg_to_wav16k", _bad_ffmpeg),
        ):
            resp = client.post("/api/transcribe-file", content=b"not-audio")

        assert resp.status_code == 200
        events = _parse_sse(resp.text)
        errors = [e for e in events if e["type"] == "error"]
        assert errors and "解碼失敗" in errors[0]["message"]
