"""db.py sqlite3 薄封裝單元測試。用 tmp 檔 SQLite，不碰真 DB。"""

from __future__ import annotations

import json

import pytest

from app import db


@pytest.fixture
def db_path(tmp_path) -> str:
    p = str(tmp_path / "test.db")
    db.init_db(p)
    return p


def test_save_and_get_round_trip(db_path: str) -> None:
    mid = db.save_meeting(
        db_path,
        title="與甲方交期會議",
        owner="YC",
        context="角色＋會議資訊",
        summary="- 重點一\n- 重點二",
        transcript="完整逐字稿全文",
        questions=[{"q": "驗收標準?", "why": "未說明"}],
    )
    assert isinstance(mid, int) and mid > 0

    got = db.get_meeting(db_path, mid)
    assert got is not None
    assert got["title"] == "與甲方交期會議"
    assert got["owner"] == "YC"
    assert got["context"] == "角色＋會議資訊"
    assert got["summary"] == "- 重點一\n- 重點二"
    assert got["transcript"] == "完整逐字稿全文"
    assert got["questions"] == [{"q": "驗收標準?", "why": "未說明"}]
    assert "created_at" in got and got["created_at"]


def test_list_orders_newest_first_and_is_lightweight(db_path: str) -> None:
    db.save_meeting(db_path, title="第一場", owner="YC", context=None,
                    summary="s1", transcript="t1", questions=[])
    db.save_meeting(db_path, title="第二場", owner="YC", context=None,
                    summary="s2", transcript="t2", questions=[])

    rows = db.list_meetings(db_path)
    assert [r["title"] for r in rows] == ["第二場", "第一場"]
    assert "summary" not in rows[0]
    assert "transcript" not in rows[0]


def test_list_filters_by_owner(db_path: str) -> None:
    db.save_meeting(db_path, title="A 的會", owner="Alice", context=None,
                    summary=None, transcript=None, questions=None)
    db.save_meeting(db_path, title="B 的會", owner="Bob", context=None,
                    summary=None, transcript=None, questions=None)

    rows = db.list_meetings(db_path, owner="Alice")
    assert len(rows) == 1
    assert rows[0]["title"] == "A 的會"


def test_get_nonexistent_returns_none(db_path: str) -> None:
    assert db.get_meeting(db_path, 99999) is None


def test_questions_default_empty_list(db_path: str) -> None:
    mid = db.save_meeting(db_path, title="無追問", owner="YC", context=None,
                          summary=None, transcript=None, questions=None)
    got = db.get_meeting(db_path, mid)
    assert got["questions"] == []
