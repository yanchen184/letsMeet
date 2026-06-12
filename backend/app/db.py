"""SQLite 持久層（會議記錄）。

純 sqlite3 薄封裝，無 ORM。內網 demo 低併發，每次操作開/關連線。
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from datetime import datetime, timezone


def _connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(path: str) -> None:
    """建表（冪等）。app 啟動時呼叫一次。"""
    with closing(_connect(path)) as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS meetings ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "title TEXT NOT NULL, owner TEXT NOT NULL, "
            "context TEXT, created_at TEXT NOT NULL, "
            "pin_code TEXT)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS meeting_contents ("
            "meeting_id INTEGER PRIMARY KEY, summary TEXT, "
            "transcript TEXT, questions TEXT, "
            "FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE)"
        )
        _ensure_column(conn, "meetings", "pin_code", "TEXT")
        conn.commit()


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, decl: str) -> None:
    """既有 DB 補欄位（冪等）。CREATE TABLE IF NOT EXISTS 不會改舊表結構。"""
    cols = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def save_meeting(
    path: str,
    *,
    title: str,
    owner: str,
    context: str | None,
    summary: str | None,
    transcript: str | None,
    questions: list[dict] | None,
    pin_code: str | None = None,
) -> int:
    """一筆 transaction 寫 meetings + meeting_contents，回 id。

    pin_code 明碼存（內網 demo，由建立會議者自設），有設則該場詳情需驗證。
    """
    created_at = datetime.now(timezone.utc).isoformat()
    questions_json = json.dumps(questions or [], ensure_ascii=False)
    with closing(_connect(path)) as conn:
        cur = conn.execute(
            "INSERT INTO meetings (title, owner, context, created_at, pin_code) "
            "VALUES (?, ?, ?, ?, ?)",
            (title, owner, context, created_at, pin_code or None),
        )
        mid = int(cur.lastrowid)
        conn.execute(
            "INSERT INTO meeting_contents (meeting_id, summary, transcript, questions) "
            "VALUES (?, ?, ?, ?)",
            (mid, summary, transcript, questions_json),
        )
        conn.commit()
    return mid


def list_meetings(path: str, owner: str | None = None) -> list[dict]:
    """列表，輕量欄位（不撈 summary/transcript），依 created_at DESC。

    回傳 is_protected 旗標（是否設了 PIN），但不外洩 pin_code 本身。
    """
    sql = (
        "SELECT id, title, owner, created_at, "
        "(pin_code IS NOT NULL AND pin_code != '') AS is_protected "
        "FROM meetings"
    )
    params: tuple = ()
    if owner is not None:
        sql += " WHERE owner = ?"
        params = (owner,)
    sql += " ORDER BY created_at DESC, id DESC"
    with closing(_connect(path)) as conn:
        rows = conn.execute(sql, params).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["is_protected"] = bool(d["is_protected"])
        result.append(d)
    return result


def get_meeting(path: str, meeting_id: int) -> dict | None:
    """單場完整內容（join 兩表）；不存在回 None。"""
    sql = (
        "SELECT m.id, m.title, m.owner, m.context, m.created_at, m.pin_code, "
        "c.summary, c.transcript, c.questions "
        "FROM meetings m LEFT JOIN meeting_contents c ON c.meeting_id = m.id "
        "WHERE m.id = ?"
    )
    with closing(_connect(path)) as conn:
        row = conn.execute(sql, (meeting_id,)).fetchone()
    if row is None:
        return None
    d = dict(row)
    d["questions"] = json.loads(d["questions"]) if d["questions"] else []
    return d
