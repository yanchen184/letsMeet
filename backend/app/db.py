"""SQLite 持久層（會議記錄）。

純 sqlite3 薄封裝，無 ORM。內網 demo 低併發，每次操作開/關連線。
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meetings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  owner      TEXT NOT NULL,
  context    TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meeting_contents (
  meeting_id INTEGER PRIMARY KEY,
  summary    TEXT,
  transcript TEXT,
  questions  TEXT,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);
"""


def _connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(path: str) -> None:
    """建表（冪等）。app 啟動時呼叫一次。"""
    with _connect(path) as conn:
        conn.executescript(_SCHEMA)


def save_meeting(
    path: str,
    *,
    title: str,
    owner: str,
    context: str | None,
    summary: str | None,
    transcript: str | None,
    questions: list | None,
) -> int:
    """一筆 transaction 寫 meetings + meeting_contents，回 id。"""
    created_at = datetime.now(timezone.utc).isoformat()
    questions_json = json.dumps(questions or [], ensure_ascii=False)
    with _connect(path) as conn:
        cur = conn.execute(
            "INSERT INTO meetings (title, owner, context, created_at) VALUES (?, ?, ?, ?)",
            (title, owner, context, created_at),
        )
        mid = int(cur.lastrowid)
        conn.execute(
            "INSERT INTO meeting_contents (meeting_id, summary, transcript, questions) "
            "VALUES (?, ?, ?, ?)",
            (mid, summary, transcript, questions_json),
        )
    return mid


def list_meetings(path: str, owner: str | None = None) -> list[dict]:
    """列表，輕量欄位（不撈 summary/transcript），依 created_at DESC。"""
    sql = "SELECT id, title, owner, created_at FROM meetings"
    params: tuple = ()
    if owner:
        sql += " WHERE owner = ?"
        params = (owner,)
    sql += " ORDER BY created_at DESC, id DESC"
    with _connect(path) as conn:
        rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def get_meeting(path: str, meeting_id: int) -> dict | None:
    """單場完整內容（join 兩表）；不存在回 None。"""
    sql = (
        "SELECT m.id, m.title, m.owner, m.context, m.created_at, "
        "c.summary, c.transcript, c.questions "
        "FROM meetings m LEFT JOIN meeting_contents c ON c.meeting_id = m.id "
        "WHERE m.id = ?"
    )
    with _connect(path) as conn:
        row = conn.execute(sql, (meeting_id,)).fetchone()
    if row is None:
        return None
    d = dict(row)
    d["questions"] = json.loads(d["questions"]) if d["questions"] else []
    return d
