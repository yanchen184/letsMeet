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
