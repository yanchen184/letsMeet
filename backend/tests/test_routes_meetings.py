"""會議記錄 3 端點 integration。DB 路徑 monkeypatch 到 tmp 檔。"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db, routes


@pytest.fixture
def db_path(tmp_path, monkeypatch) -> str:
    p = str(tmp_path / "routes_test.db")
    db.init_db(p)
    monkeypatch.setattr(routes, "DB_PATH", p, raising=False)
    return p


@pytest.fixture
def client(db_path: str) -> TestClient:
    app = FastAPI()
    app.include_router(routes.router)
    return TestClient(app)


def test_post_meeting_returns_id(client: TestClient) -> None:
    resp = client.post(
        "/api/meetings",
        json={
            "title": "與甲方交期會議",
            "owner": "YC",
            "context": "角色＋資訊",
            "summary": "- 重點一",
            "transcript": "逐字稿",
            "questions": [{"q": "驗收標準?", "why": "未說明"}],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert isinstance(body["id"], int) and body["id"] > 0
    assert "X-Request-Id" in resp.headers


def test_post_meeting_empty_title_returns_422(client: TestClient) -> None:
    resp = client.post("/api/meetings", json={"title": "  ", "owner": "YC"})
    assert resp.status_code == 422
    assert "title" in resp.json()["error"] or "標題" in resp.json()["error"]


def test_post_meeting_empty_owner_returns_422(client: TestClient) -> None:
    resp = client.post("/api/meetings", json={"title": "會議", "owner": ""})
    assert resp.status_code == 422


def test_get_meetings_list(client: TestClient) -> None:
    client.post("/api/meetings", json={"title": "第一場", "owner": "YC"})
    client.post("/api/meetings", json={"title": "第二場", "owner": "YC"})

    resp = client.get("/api/meetings")
    assert resp.status_code == 200
    rows = resp.json()["meetings"]
    assert [r["title"] for r in rows] == ["第二場", "第一場"]
    assert "transcript" not in rows[0]


def test_get_meetings_filter_by_owner(client: TestClient) -> None:
    client.post("/api/meetings", json={"title": "A 的會", "owner": "Alice"})
    client.post("/api/meetings", json={"title": "B 的會", "owner": "Bob"})

    resp = client.get("/api/meetings", params={"owner": "Alice"})
    assert resp.status_code == 200
    rows = resp.json()["meetings"]
    assert len(rows) == 1 and rows[0]["title"] == "A 的會"


def test_get_meeting_by_id(client: TestClient) -> None:
    mid = client.post(
        "/api/meetings",
        json={"title": "詳情會", "owner": "YC", "summary": "- 重點",
              "transcript": "逐字稿全文", "questions": [{"q": "Q1", "why": "W1"}]},
    ).json()["id"]

    resp = client.get(f"/api/meetings/{mid}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["title"] == "詳情會"
    assert body["summary"] == "- 重點"
    assert body["transcript"] == "逐字稿全文"
    assert body["questions"] == [{"q": "Q1", "why": "W1"}]


def test_get_meeting_not_found_returns_404(client: TestClient) -> None:
    resp = client.get("/api/meetings/99999")
    assert resp.status_code == 404
    assert "error" in resp.json()
