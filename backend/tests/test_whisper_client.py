"""whisper_client.transcribe 單元測試（httpx mock）。"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app import whisper_client


_FAKE_REQUEST = httpx.Request("POST", "http://whisper.cpp/inference")


def _response(status: int, json_body: dict | None = None) -> httpx.Response:
    """建立已綁定 request 的 httpx.Response（raise_for_status 需要）。"""
    return httpx.Response(status, json=json_body or {}, request=_FAKE_REQUEST)


def _mock_async_client(response: httpx.Response | Exception) -> AsyncMock:
    """建構一個可當作 `async with httpx.AsyncClient(...)` 使用的 mock。"""
    client = AsyncMock()
    if isinstance(response, Exception):
        client.post = AsyncMock(side_effect=response)
    else:
        client.post = AsyncMock(return_value=response)
    ctx = AsyncMock()
    ctx.__aenter__.return_value = client
    ctx.__aexit__.return_value = False
    return ctx


@pytest.mark.unit
class TestTranscribe:
    async def test_success_returns_text(self) -> None:
        resp = _response(200, {"text": "  哈囉世界 "})
        with patch.object(whisper_client.httpx, "AsyncClient", return_value=_mock_async_client(resp)):
            text = await whisper_client.transcribe(b"fakewav", language="zh")
        assert text == "哈囉世界"

    async def test_missing_text_field_returns_empty(self) -> None:
        resp = _response(200, {})
        with patch.object(whisper_client.httpx, "AsyncClient", return_value=_mock_async_client(resp)):
            text = await whisper_client.transcribe(b"fakewav")
        assert text == ""

    async def test_http_status_error_returns_empty(self) -> None:
        resp = _response(500)
        with patch.object(whisper_client.httpx, "AsyncClient", return_value=_mock_async_client(resp)):
            text = await whisper_client.transcribe(b"fakewav")
        assert text == ""

    async def test_timeout_returns_empty(self) -> None:
        with patch.object(
            whisper_client.httpx,
            "AsyncClient",
            return_value=_mock_async_client(httpx.TimeoutException("slow")),
        ):
            text = await whisper_client.transcribe(b"fakewav")
        assert text == ""

    async def test_connect_error_returns_empty(self) -> None:
        with patch.object(
            whisper_client.httpx,
            "AsyncClient",
            return_value=_mock_async_client(httpx.ConnectError("unreachable")),
        ):
            text = await whisper_client.transcribe(b"fakewav")
        assert text == ""

    async def test_unexpected_exception_returns_empty(self) -> None:
        with patch.object(
            whisper_client.httpx,
            "AsyncClient",
            return_value=_mock_async_client(RuntimeError("wat")),
        ):
            text = await whisper_client.transcribe(b"fakewav")
        assert text == ""
