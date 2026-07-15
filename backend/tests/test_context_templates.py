"""會議背景範本庫：db 層 CRUD + /api/contexts 4 端點 integration。"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db, routes


@pytest.fixture
def db_path(tmp_path) -> str:
    p = str(tmp_path / "ctx_test.db")
    db.init_db(p)
    return p


@pytest.fixture
def client(db_path: str, monkeypatch) -> TestClient:
    monkeypatch.setattr(routes, "DB_PATH", db_path, raising=False)
    app = FastAPI()
    app.include_router(routes.router)
    return TestClient(app)


# ── db 層 ────────────────────────────────────────────────────────────────


def test_init_seeds_builtin_templates(db_path: str) -> None:
    rows = db.list_context_templates(db_path)
    names = [r["name"] for r in rows]
    assert names == ["跟甲方溝通", "跟工程師溝通", "跟 PM 溝通", "工程師 × PM"]
    assert all(r["role_text"] for r in rows)
    for r in rows:
        assert set(r) >= {"id", "name", "role_text", "goal_text", "updated_at"}


def test_save_and_list_round_trip(db_path: str) -> None:
    tid = db.save_context_template(
        db_path, name="週會", role_text="我是主持人", goal_text="每週例行同步"
    )
    assert isinstance(tid, int) and tid > 0
    rows = db.list_context_templates(db_path)
    got = next(r for r in rows if r["id"] == tid)
    assert got["name"] == "週會"
    assert got["role_text"] == "我是主持人"
    assert got["goal_text"] == "每週例行同步"


def test_save_duplicate_name_raises(db_path: str) -> None:
    db.save_context_template(db_path, name="週會", role_text="x", goal_text="")
    import sqlite3

    with pytest.raises(sqlite3.IntegrityError):
        db.save_context_template(db_path, name="週會", role_text="y", goal_text="")


def test_update_template(db_path: str) -> None:
    tid = db.save_context_template(db_path, name="週會", role_text="a", goal_text="b")
    ok = db.update_context_template(
        db_path, tid, name="月會", role_text="c", goal_text="d"
    )
    assert ok is True
    got = next(r for r in db.list_context_templates(db_path) if r["id"] == tid)
    assert (got["name"], got["role_text"], got["goal_text"]) == ("月會", "c", "d")


def test_update_missing_returns_false(db_path: str) -> None:
    assert db.update_context_template(db_path, 99999, name="x") is False


def test_delete_template(db_path: str) -> None:
    tid = db.save_context_template(db_path, name="臨時", role_text="r", goal_text="")
    assert db.delete_context_template(db_path, tid) is True
    assert all(r["id"] != tid for r in db.list_context_templates(db_path))
    assert db.delete_context_template(db_path, tid) is False


def test_seed_only_once_deleted_seed_stays_deleted(db_path: str) -> None:
    rows = db.list_context_templates(db_path)
    db.delete_context_template(db_path, rows[0]["id"])
    db.init_db(db_path)  # app 重啟不會把刪掉的內建範本種回來
    names = [r["name"] for r in db.list_context_templates(db_path)]
    assert "跟甲方溝通" not in names
    assert len(names) == 3


# ── /api/contexts 路由 ───────────────────────────────────────────────────


def test_get_contexts_returns_seeds(client: TestClient) -> None:
    resp = client.get("/api/contexts")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [t["name"] for t in body["contexts"]][:1] == ["跟甲方溝通"]
    assert len(body["contexts"]) == 4
    assert "X-Request-Id" in resp.headers


def test_post_context_creates(client: TestClient) -> None:
    resp = client.post(
        "/api/contexts",
        json={"name": "週會", "role_text": "我是主持人", "goal_text": "同步進度"},
    )
    assert resp.status_code == 200, resp.text
    tid = resp.json()["id"]
    assert isinstance(tid, int) and tid > 0
    names = [t["name"] for t in client.get("/api/contexts").json()["contexts"]]
    assert "週會" in names


def test_post_context_empty_name_422(client: TestClient) -> None:
    resp = client.post("/api/contexts", json={"name": "  ", "role_text": "x"})
    assert resp.status_code == 422
    assert "name" in resp.json()["error"] or "名稱" in resp.json()["error"]


def test_post_context_duplicate_name_409(client: TestClient) -> None:
    client.post("/api/contexts", json={"name": "週會", "role_text": "x"})
    resp = client.post("/api/contexts", json={"name": "週會", "role_text": "y"})
    assert resp.status_code == 409


def test_put_context_updates(client: TestClient) -> None:
    tid = client.post(
        "/api/contexts", json={"name": "週會", "role_text": "a", "goal_text": "b"}
    ).json()["id"]
    resp = client.put(
        f"/api/contexts/{tid}",
        json={"name": "月會", "role_text": "c", "goal_text": "d"},
    )
    assert resp.status_code == 200, resp.text
    got = next(
        t for t in client.get("/api/contexts").json()["contexts"] if t["id"] == tid
    )
    assert (got["name"], got["role_text"], got["goal_text"]) == ("月會", "c", "d")


def test_put_context_missing_404(client: TestClient) -> None:
    resp = client.put("/api/contexts/99999", json={"name": "x"})
    assert resp.status_code == 404


def test_put_context_duplicate_name_409(client: TestClient) -> None:
    client.post("/api/contexts", json={"name": "週會", "role_text": "x"})
    tid = client.post("/api/contexts", json={"name": "月會", "role_text": "y"}).json()["id"]
    resp = client.put(f"/api/contexts/{tid}", json={"name": "週會"})
    assert resp.status_code == 409


def test_delete_context(client: TestClient) -> None:
    tid = client.post(
        "/api/contexts", json={"name": "臨時", "role_text": "r"}
    ).json()["id"]
    resp = client.delete(f"/api/contexts/{tid}")
    assert resp.status_code == 200, resp.text
    assert all(
        t["id"] != tid for t in client.get("/api/contexts").json()["contexts"]
    )
    assert client.delete(f"/api/contexts/{tid}").status_code == 404
