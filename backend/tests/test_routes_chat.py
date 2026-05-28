"""POST /api/digest（重點摘要）+ POST /api/chat（SSE streaming）integration。"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import LLM_BASE_URL
from app.routes import router


@pytest.fixture
def client() -> TestClient:
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


@pytest.fixture
def llm_url() -> str:
    return f"{LLM_BASE_URL.rstrip('/')}/chat/completions"


# ── /api/digest ────────────────────────────────────────────────────────────────


@pytest.mark.integration
class TestDigest:
    def test_empty_transcript_returns_422(self, client: TestClient) -> None:
        resp = client.post("/api/digest", json={"transcript": "   "})
        assert resp.status_code == 422
        assert "transcript" in resp.json()["error"]

    def test_returns_summary(self, client: TestClient, httpx_mock, llm_url: str) -> None:
        httpx_mock.add_response(
            url=llm_url,
            method="POST",
            json={"choices": [{"message": {"content": "- 重點一\n- 重點二"}}]},
        )
        resp = client.post("/api/digest", json={"transcript": "甲方說交期要提前到月底"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["summary"] == "- 重點一\n- 重點二"
        assert "X-Request-Id" in resp.headers

    def test_llm_http_error_returns_502(self, client: TestClient, httpx_mock, llm_url: str) -> None:
        httpx_mock.add_response(url=llm_url, method="POST", status_code=500)
        resp = client.post("/api/digest", json={"transcript": "甲方說交期"})
        assert resp.status_code == 502

    def test_llm_timeout_returns_504(self, client: TestClient, httpx_mock, llm_url: str) -> None:
        httpx_mock.add_exception(httpx.ReadTimeout("timeout"))
        resp = client.post("/api/digest", json={"transcript": "甲方說交期"})
        assert resp.status_code == 504


# ── /api/chat ──────────────────────────────────────────────────────────────────


def _sse_body(deltas: list[str]) -> bytes:
    """組一段 OpenAI streaming chunk SSE body。"""
    lines = []
    for d in deltas:
        chunk = '{"choices":[{"delta":{"content":"%s"}}]}' % d
        lines.append(f"data: {chunk}")
    lines.append("data: [DONE]")
    return ("\n\n".join(lines) + "\n\n").encode()


@pytest.mark.integration
class TestChat:
    def test_empty_messages_returns_422(self, client: TestClient) -> None:
        resp = client.post("/api/chat", json={"messages": []})
        assert resp.status_code == 422
        assert "messages" in resp.json()["error"]

    def test_blank_message_content_returns_422(self, client: TestClient) -> None:
        resp = client.post("/api/chat", json={"messages": [{"role": "user", "content": "  "}]})
        assert resp.status_code == 422

    def test_streams_deltas_as_sse(self, client: TestClient, httpx_mock, llm_url: str) -> None:
        httpx_mock.add_response(
            url=llm_url,
            method="POST",
            status_code=200,
            content=_sse_body(["你", "好"]),
            headers={"Content-Type": "text/event-stream"},
        )
        resp = client.post(
            "/api/chat",
            json={
                "messages": [{"role": "user", "content": "嗨"}],
                "transcript": "甲方說要月底交付",
            },
        )
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        body = resp.text
        assert '"delta": "你"' in body
        assert '"delta": "好"' in body
        assert "data: [DONE]" in body

    def test_upstream_error_emitted_in_stream(self, client: TestClient, httpx_mock, llm_url: str) -> None:
        httpx_mock.add_exception(httpx.ReadTimeout("timeout"))
        resp = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "嗨"}]},
        )
        # SSE：連線已建立，錯誤走 data 事件而非 HTTP code
        assert resp.status_code == 200
        assert "超時" in resp.text
