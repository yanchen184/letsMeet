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


def test_pin_stored_and_listed_as_protected(db_path: str) -> None:
    mid = db.save_meeting(db_path, title="機密會", owner="YC", context=None,
                          summary="s", transcript="t", questions=None,
                          pin_code="1234")
    # get 撈得到明碼 pin（供 route 比對）
    assert db.get_meeting(db_path, mid)["pin_code"] == "1234"
    # list 只回 is_protected 旗標，不外洩 pin
    rows = db.list_meetings(db_path)
    assert rows[0]["is_protected"] is True
    assert "pin_code" not in rows[0]


def test_no_pin_is_not_protected(db_path: str) -> None:
    mid = db.save_meeting(db_path, title="公開會", owner="YC", context=None,
                          summary=None, transcript=None, questions=None)
    assert db.get_meeting(db_path, mid)["pin_code"] is None
    assert db.list_meetings(db_path)[0]["is_protected"] is False


def test_init_db_adds_pin_column_to_legacy_table(tmp_path) -> None:
    """舊 DB（無 pin_code 欄）再次 init_db 應冪等補欄，不報錯。"""
    import sqlite3

    p = str(tmp_path / "legacy.db")
    conn = sqlite3.connect(p)
    conn.execute(
        "CREATE TABLE meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "title TEXT NOT NULL, owner TEXT NOT NULL, context TEXT, created_at TEXT NOT NULL)"
    )
    conn.commit()
    conn.close()

    db.init_db(p)  # 應補上 pin_code 欄
    mid = db.save_meeting(p, title="升級後", owner="YC", context=None,
                          summary=None, transcript=None, questions=None,
                          pin_code="9999")
    assert db.get_meeting(p, mid)["pin_code"] == "9999"
