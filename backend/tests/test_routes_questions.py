"""POST /api/questions 端到端 integration（mock LLM upstream）。"""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import LLM_BASE_URL
from app.routes import router


@pytest.fixture
def client() -> TestClient:
    from fastapi import FastAPI

    # 不用 app.main:app，避免 lifespan 嘗試載 Whisper 模型
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


@pytest.fixture
def llm_url() -> str:
    return f"{LLM_BASE_URL.rstrip('/')}/chat/completions"


# ── 422 短路 ──────────────────────────────────────────────────────────────────


@pytest.mark.integration
class TestQuestionsValidation:
    def test_empty_transcript_returns_422(self, client: TestClient) -> None:
        resp = client.post("/api/questions", json={"transcript": "  "})
        assert resp.status_code == 422
        assert "transcript" in resp.json()["error"]

    def test_missing_transcript_returns_422(self, client: TestClient) -> None:
        resp = client.post("/api/questions", json={})
        # pydantic 422
        assert resp.status_code == 422


# ── happy path ────────────────────────────────────────────────────────────────


@pytest.mark.integration
class TestQuestionsHappyPath:
    def test_short_transcript_returns_questions(
        self,
        client: TestClient,
        httpx_mock,
        llm_url: str,
    ) -> None:
        # mock LLM 回傳合法 JSON
        httpx_mock.add_response(
            url=llm_url,
            method="POST",
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps({
                                "questions": [
                                    {"q": "驗收標準是？", "why": "對方未說明"},
                                    {"q": "誰能拍板？", "why": "對方說『回去問』"},
                                    {"q": "預算上限？", "why": "未提"},
                                ]
                            })
                        }
                    }
                ]
            },
        )

        resp = client.post(
            "/api/questions",
            json={"transcript": "甲方說我們再看驗收"},
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert len(body["questions"]) == 3
        assert body["questions"][0]["q"] == "驗收標準是？"
        assert body["truncated"] is False
        assert body["summary"] is None
        assert "X-Request-Id" in resp.headers


# ── 502 / 504 錯誤分流 ────────────────────────────────────────────────────────


@pytest.mark.integration
class TestQuestionsErrorHandling:
    def test_llm_returns_garbage_returns_502(
        self,
        client: TestClient,
        httpx_mock,
        llm_url: str,
    ) -> None:
        httpx_mock.add_response(
            url=llm_url,
            method="POST",
            json={
                "choices": [{"message": {"content": "not even close to json"}}]
            },
        )

        resp = client.post(
            "/api/questions",
            json={"transcript": "甲方說我們再看"},
        )

        assert resp.status_code == 502
        assert "格式" in resp.json()["error"]

    def test_llm_http_error_returns_502(
        self,
        client: TestClient,
        httpx_mock,
        llm_url: str,
    ) -> None:
        for _ in range(3):  # 首發 + 2 次重試全部 500
            httpx_mock.add_response(url=llm_url, method="POST", status_code=500)

        resp = client.post(
            "/api/questions",
            json={"transcript": "甲方說我們再看"},
        )

        assert resp.status_code == 502
        assert "LLM" in resp.json()["error"]

    def test_llm_timeout_returns_504(
        self,
        client: TestClient,
        httpx_mock,
        llm_url: str,
    ) -> None:
        httpx_mock.add_exception(httpx.ReadTimeout("timeout"))

        resp = client.post(
            "/api/questions",
            json={"transcript": "甲方說我們再看"},
        )

        assert resp.status_code == 504
        assert "超時" in resp.json()["error"]
