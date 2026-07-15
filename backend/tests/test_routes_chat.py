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
        for _ in range(3):  # 首發 + 2 次重試全部 500
            httpx_mock.add_response(url=llm_url, method="POST", status_code=500)
        resp = client.post("/api/digest", json={"transcript": "甲方說交期"})
        assert resp.status_code == 502

    def test_llm_timeout_returns_504(self, client: TestClient, httpx_mock, llm_url: str) -> None:
        httpx_mock.add_exception(httpx.ReadTimeout("timeout"))
        resp = client.post("/api/digest", json={"transcript": "甲方說交期"})
        assert resp.status_code == 504


# ── /api/minutes ────────────────────────────────────────────────────────────────


@pytest.mark.integration
class TestMinutes:
    def test_empty_transcript_returns_422(self, client: TestClient) -> None:
        resp = client.post("/api/minutes", json={"transcript": "   "})
        assert resp.status_code == 422
        assert "transcript" in resp.json()["error"]

    def test_returns_minutes(self, client: TestClient, httpx_mock, llm_url: str) -> None:
        doc = "## 會議重點\n- 交期提前到月底\n\n## 決議事項\n-（無）"
        httpx_mock.add_response(
            url=llm_url,
            method="POST",
            json={"choices": [{"message": {"content": doc}}]},
        )
        resp = client.post(
            "/api/minutes",
            json={"transcript": "甲方說交期要提前到月底", "context": "乙方 PM 對甲方"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["minutes"] == doc
        assert "X-Request-Id" in resp.headers

    def test_llm_http_error_returns_502(self, client: TestClient, httpx_mock, llm_url: str) -> None:
        for _ in range(3):  # 首發 + 2 次重試全部 500
            httpx_mock.add_response(url=llm_url, method="POST", status_code=500)
        resp = client.post("/api/minutes", json={"transcript": "甲方說交期"})
        assert resp.status_code == 502

    def test_llm_timeout_returns_504(self, client: TestClient, httpx_mock, llm_url: str) -> None:
        httpx_mock.add_exception(httpx.ReadTimeout("timeout"))
        resp = client.post("/api/minutes", json={"transcript": "甲方說交期"})
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

    def test_non_sse_json_response_falls_back_to_single_delta(
        self, client: TestClient, httpx_mock, llm_url: str
    ) -> None:
        """LLM 服務無視 stream:true 回完整 JSON（線上實測行為）→ 內容仍要一次吐出。"""
        httpx_mock.add_response(
            url=llm_url,
            method="POST",
            json={"choices": [{"message": {"content": "你好，我是 AI"}}]},
        )
        resp = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "嗨"}]},
        )
        assert resp.status_code == 200
        assert '"delta": "你好，我是 AI"' in resp.text
        assert "data: [DONE]" in resp.text

    def test_chat_retries_on_500_then_streams(
        self, client: TestClient, httpx_mock, llm_url: str
    ) -> None:
        """間歇 500（GPU contention）→ 開串流前重試一次成功。"""
        httpx_mock.add_response(url=llm_url, method="POST", status_code=500)
        httpx_mock.add_response(
            url=llm_url,
            method="POST",
            status_code=200,
            content=_sse_body(["重", "試", "成", "功"]),
            headers={"Content-Type": "text/event-stream"},
        )
        resp = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "嗨"}]},
        )
        assert resp.status_code == 200
        assert '"delta": "重"' in resp.text
        assert '"delta": "功"' in resp.text
        assert "data: [DONE]" in resp.text


@pytest.mark.integration
class TestLLMRetry:
    def test_digest_retries_on_500_then_succeeds(
        self, client: TestClient, httpx_mock, llm_url: str
    ) -> None:
        httpx_mock.add_response(url=llm_url, method="POST", status_code=500)
        httpx_mock.add_response(
            url=llm_url,
            method="POST",
            json={"choices": [{"message": {"content": "- 重點一"}}]},
        )
        resp = client.post("/api/digest", json={"transcript": "甲方說交期要提前"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["summary"] == "- 重點一"

    def test_digest_exhausted_retries_returns_502(
        self, client: TestClient, httpx_mock, llm_url: str
    ) -> None:
        for _ in range(3):  # 首發 + 2 次重試全部 500
            httpx_mock.add_response(url=llm_url, method="POST", status_code=500)
        resp = client.post("/api/digest", json={"transcript": "甲方說交期要提前"})
        assert resp.status_code == 502
