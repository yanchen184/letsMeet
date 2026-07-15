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
        # 結構化待辦：從會議記錄抽出的待辦事項，可跨會議聚合追蹤。
        # status: open（未結）/ done（已完成）。source 會議刪除時一併清掉。
        conn.execute(
            "CREATE TABLE IF NOT EXISTS action_items ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "meeting_id INTEGER NOT NULL, "
            "assignee TEXT, task TEXT NOT NULL, due TEXT, "
            "status TEXT NOT NULL DEFAULT 'open', "
            "created_at TEXT NOT NULL, "
            "FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_action_items_status "
            "ON action_items(status)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_action_items_meeting "
            "ON action_items(meeting_id)"
        )
        _ensure_column(conn, "meetings", "pin_code", "TEXT")
        _ensure_column(conn, "meeting_contents", "minutes", "TEXT")
        # 會議背景範本庫：使用者可自建 / 改 / 刪。內建 4 種情境只在建表當下種一次，
        # 之後使用者刪掉不會在重啟時被種回來（所以先查表存在與否再 CREATE）。
        had_ctx_table = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='context_templates'"
        ).fetchone() is not None
        conn.execute(
            "CREATE TABLE IF NOT EXISTS context_templates ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "name TEXT NOT NULL UNIQUE, "
            "role_text TEXT NOT NULL DEFAULT '', "
            "goal_text TEXT NOT NULL DEFAULT '', "
            "created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
        )
        if not had_ctx_table:
            _seed_context_templates(conn)
        # 全文搜尋：FTS5 + trigram tokenizer（中文子字串比對可靠，unicode61 對 CJK 不斷詞）。
        # rowid = meeting_id，寫入/更新時手動同步（見 _sync_fts）；is_protected 場的內容
        # 仍會進索引，但 search 只回 meta（title/owner），不外洩內文，詳情頁照樣要 PIN。
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts USING fts5("
            "title, owner, summary, transcript, minutes, questions, "
            "tokenize='trigram')"
        )
        conn.commit()
        _rebuild_fts_if_empty(conn)
        conn.commit()


def _rebuild_fts_if_empty(conn: sqlite3.Connection) -> None:
    """FTS 表沒資料但 meetings 有 → 回填（首次建索引 / 既有 DB 升級）。"""
    fts_count = conn.execute("SELECT COUNT(*) FROM meetings_fts").fetchone()[0]
    mtg_count = conn.execute("SELECT COUNT(*) FROM meetings").fetchone()[0]
    if fts_count > 0 or mtg_count == 0:
        return
    rows = conn.execute(
        "SELECT m.id, m.title, m.owner, c.summary, c.transcript, c.minutes, c.questions "
        "FROM meetings m LEFT JOIN meeting_contents c ON c.meeting_id = m.id"
    ).fetchall()
    for r in rows:
        _upsert_fts_row(conn, r["id"], dict(r))


def _fts_questions_text(questions_json: str | None) -> str:
    """把 questions JSON 攤平成可搜的純文字（只取 q/why 文字）。"""
    if not questions_json:
        return ""
    try:
        items = json.loads(questions_json)
    except (ValueError, TypeError):
        return ""
    parts: list[str] = []
    for it in items or []:
        if isinstance(it, dict):
            parts.append(str(it.get("q", "")))
            parts.append(str(it.get("why", "")))
    return " ".join(p for p in parts if p)


def _upsert_fts_row(conn: sqlite3.Connection, meeting_id: int, fields: dict) -> None:
    """以 meeting_id 為 rowid 重寫一列 FTS（先刪後插，避免重複）。"""
    conn.execute("DELETE FROM meetings_fts WHERE rowid = ?", (meeting_id,))
    conn.execute(
        "INSERT INTO meetings_fts "
        "(rowid, title, owner, summary, transcript, minutes, questions) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            meeting_id,
            fields.get("title") or "",
            fields.get("owner") or "",
            fields.get("summary") or "",
            fields.get("transcript") or "",
            fields.get("minutes") or "",
            _fts_questions_text(fields.get("questions")),
        ),
    )


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
    minutes: str | None = None,
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
            "INSERT INTO meeting_contents (meeting_id, summary, transcript, questions, minutes) "
            "VALUES (?, ?, ?, ?, ?)",
            (mid, summary, transcript, questions_json, minutes),
        )
        _upsert_fts_row(
            conn,
            mid,
            {
                "title": title,
                "owner": owner,
                "summary": summary,
                "transcript": transcript,
                "minutes": minutes,
                "questions": questions_json,
            },
        )
        conn.commit()
    return mid


_UNSET = object()


def update_meeting(
    path: str,
    meeting_id: int,
    *,
    title: str | object = _UNSET,
    owner: str | object = _UNSET,
    pin_code: str | None | object = _UNSET,
    summary: str | None | object = _UNSET,
    transcript: str | None | object = _UNSET,
    questions: list[dict] | None | object = _UNSET,
    minutes: str | None | object = _UNSET,
) -> bool:
    """部分更新一場會議（自動歸檔後補 minutes / 手動存檔改標題用）。

    只更新有傳入的欄位；不存在回 False。
    """
    meta_sets: list[str] = []
    meta_params: list = []
    if title is not _UNSET:
        meta_sets.append("title = ?")
        meta_params.append(title)
    if owner is not _UNSET:
        meta_sets.append("owner = ?")
        meta_params.append(owner)
    if pin_code is not _UNSET:
        meta_sets.append("pin_code = ?")
        meta_params.append(pin_code)

    content_sets: list[str] = []
    content_params: list = []
    if summary is not _UNSET:
        content_sets.append("summary = ?")
        content_params.append(summary)
    if transcript is not _UNSET:
        content_sets.append("transcript = ?")
        content_params.append(transcript)
    if questions is not _UNSET:
        content_sets.append("questions = ?")
        content_params.append(json.dumps(questions or [], ensure_ascii=False))
    if minutes is not _UNSET:
        content_sets.append("minutes = ?")
        content_params.append(minutes)

    with closing(_connect(path)) as conn:
        row = conn.execute(
            "SELECT id FROM meetings WHERE id = ?", (meeting_id,)
        ).fetchone()
        if row is None:
            return False
        if meta_sets:
            conn.execute(
                f"UPDATE meetings SET {', '.join(meta_sets)} WHERE id = ?",
                (*meta_params, meeting_id),
            )
        if content_sets:
            conn.execute(
                f"UPDATE meeting_contents SET {', '.join(content_sets)} "
                "WHERE meeting_id = ?",
                (*content_params, meeting_id),
            )
        # 部分更新 → 讀回該場最新全欄重寫 FTS（只 upsert 有改的欄位不夠，索引要整列一致）
        if meta_sets or content_sets:
            cur = conn.execute(
                "SELECT m.title, m.owner, c.summary, c.transcript, c.minutes, c.questions "
                "FROM meetings m LEFT JOIN meeting_contents c ON c.meeting_id = m.id "
                "WHERE m.id = ?",
                (meeting_id,),
            ).fetchone()
            if cur is not None:
                _upsert_fts_row(conn, meeting_id, dict(cur))
        conn.commit()
    return True


def search_meetings(path: str, query: str, limit: int = 50) -> list[dict]:
    """全文搜尋會議（trigram FTS5，跨 title/owner/summary/transcript/minutes/questions）。

    回傳輕量 meta（不外洩內文；受 PIN 保護的場詳情仍要驗證）+ 命中片段 snippet。
    query 為使用者原始輸入，trigram 對 CJK 做子字串比對，需 ≥ 1 字。
    """
    q = (query or "").strip()
    if not q:
        return []
    with closing(_connect(path)) as conn:
        # trigram 需 ≥ 3 字元才建 gram → 查詢 < 3 字（含中文 2 字詞、人名）走 LIKE 掃描；
        # ≥ 3 字走 FTS5 trigram（有索引、快）。內網資料量小，LIKE 掃描亦可接受。
        if len(q) < 3:
            rows = _search_like(conn, q, limit)
        else:
            rows = _search_fts(conn, q, limit)
    result = []
    for r in rows:
        d = dict(r)
        d["is_protected"] = bool(d["is_protected"])
        # PIN 保護的場不外洩 snippet 內文,只給 meta
        if d["is_protected"]:
            d["snippet"] = None
        result.append(d)
    return result


def _search_fts(conn: sqlite3.Connection, q: str, limit: int) -> list:
    # FTS5 MATCH 會把特殊字元當運算子 → 用雙引號包成 phrase，內部雙引號跳脫。
    phrase = '"' + q.replace('"', '""') + '"'
    sql = (
        "SELECT m.id, m.title, m.owner, m.created_at, "
        "(m.pin_code IS NOT NULL AND m.pin_code != '') AS is_protected, "
        "snippet(meetings_fts, -1, '[', ']', ' … ', 12) AS snippet "
        "FROM meetings_fts f "
        "JOIN meetings m ON m.id = f.rowid "
        "WHERE meetings_fts MATCH ? "
        "ORDER BY rank "
        "LIMIT ?"
    )
    try:
        return conn.execute(sql, (phrase, limit)).fetchall()
    except sqlite3.OperationalError:
        # 極端符號讓 FTS5 解析失敗 → 退回 LIKE，不讓 API 500
        return _search_like(conn, q, limit)


def _search_like(conn: sqlite3.Connection, q: str, limit: int) -> list:
    # LIKE 子字串比對（跳脫 % _ \），跨 meta + 內容欄；短查詢 / FTS 解析失敗時用。
    esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    like = f"%{esc}%"
    sql = (
        "SELECT m.id, m.title, m.owner, m.created_at, "
        "(m.pin_code IS NOT NULL AND m.pin_code != '') AS is_protected, "
        "NULL AS snippet "
        "FROM meetings m LEFT JOIN meeting_contents c ON c.meeting_id = m.id "
        "WHERE m.title LIKE ? ESCAPE '\\' OR m.owner LIKE ? ESCAPE '\\' "
        "OR c.summary LIKE ? ESCAPE '\\' OR c.transcript LIKE ? ESCAPE '\\' "
        "OR c.minutes LIKE ? ESCAPE '\\' OR c.questions LIKE ? ESCAPE '\\' "
        "ORDER BY m.created_at DESC, m.id DESC "
        "LIMIT ?"
    )
    return conn.execute(sql, (like, like, like, like, like, like, limit)).fetchall()


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
        "c.summary, c.transcript, c.questions, c.minutes "
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


# ── 結構化待辦（action items）───────────────────────────────────────────────

def replace_action_items(
    path: str, meeting_id: int, items: list[dict]
) -> list[dict]:
    """以整組覆寫某會議的待辦（先刪後插，冪等）。回寫入後的完整列（含 id）。

    items 每筆：{assignee?, task, due?}。task 為空的略過。已標 done 的舊項會一併
    被清掉——覆寫語意用於「產/重產會議記錄」時同步待辦，呼叫端自行決定時機。
    """
    created_at = datetime.now(timezone.utc).isoformat()
    clean = [
        it for it in (items or [])
        if isinstance(it, dict) and str(it.get("task", "")).strip()
    ]
    with closing(_connect(path)) as conn:
        conn.execute(
            "DELETE FROM action_items WHERE meeting_id = ?", (meeting_id,)
        )
        for it in clean:
            conn.execute(
                "INSERT INTO action_items "
                "(meeting_id, assignee, task, due, status, created_at) "
                "VALUES (?, ?, ?, ?, 'open', ?)",
                (
                    meeting_id,
                    (str(it.get("assignee", "")).strip() or None),
                    str(it["task"]).strip(),
                    (str(it.get("due", "")).strip() or None),
                    created_at,
                ),
            )
        conn.commit()
    return list_action_items_for_meeting(path, meeting_id)


def list_action_items_for_meeting(path: str, meeting_id: int) -> list[dict]:
    """單場會議的待辦（依 id）。"""
    with closing(_connect(path)) as conn:
        rows = conn.execute(
            "SELECT id, meeting_id, assignee, task, due, status, created_at "
            "FROM action_items WHERE meeting_id = ? ORDER BY id",
            (meeting_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def list_open_action_items(path: str, limit: int = 200) -> list[dict]:
    """跨會議所有未結待辦，附來源會議標題/日期，供追蹤看板。"""
    with closing(_connect(path)) as conn:
        rows = conn.execute(
            "SELECT a.id, a.meeting_id, a.assignee, a.task, a.due, a.status, "
            "a.created_at, m.title AS meeting_title, m.created_at AS meeting_created_at "
            "FROM action_items a JOIN meetings m ON m.id = a.meeting_id "
            "WHERE a.status = 'open' "
            "ORDER BY m.created_at DESC, a.id "
            "LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def update_action_item_status(path: str, item_id: int, status: str) -> bool:
    """改單筆待辦狀態（open/done）。不存在回 False。"""
    if status not in ("open", "done"):
        raise ValueError(f"invalid status: {status!r}")
    with closing(_connect(path)) as conn:
        cur = conn.execute(
            "UPDATE action_items SET status = ? WHERE id = ?",
            (status, item_id),
        )
        conn.commit()
        return cur.rowcount > 0


# ── 會議背景範本庫 ──────────────────────────────────────────────────────────

# 內建 4 種溝通情境（原前端寫死的 CONTEXT_PRESETS），建表時種入 DB 供使用者改/刪。
_BUILTIN_CONTEXT_TEMPLATES: list[tuple[str, str]] = [
    (
        "跟甲方溝通",
        "我是乙方專案經理，正在跟甲方／客戶開會。請站在我的立場，幫我追問釐清需求、"
        "驗收標準、範圍邊界、變更誰拍板、時程與費用，把對方含糊或保留的說法挖清楚。",
    ),
    (
        "跟工程師溝通",
        "我是 PM／需求方，正在跟工程師討論實作。請幫我追問技術可行性、工時估算依據、"
        "技術依賴與卡點、潛在風險、以及「做不完時砍什麼」的取捨，避免工程師低估或漏講風險。",
    ),
    (
        "跟 PM 溝通",
        "我是工程師，正在跟 PM／產品方對需求。請幫我追問規格細節、需求優先序、"
        "驗收條件、deadline 是否合理、誰能拍板改規格，把模糊的需求變成可實作的明確條件。",
    ),
    (
        "工程師 × PM",
        "這是工程師與 PM 的協調會議，我要居中釐清雙方落差。請幫我追問：規格認知是否一致、"
        "估時與期程有沒有衝突、技術債與功能取捨怎麼決定、變更與責任歸屬，讓兩邊對齊。",
    ),
]


def _seed_context_templates(conn: sqlite3.Connection) -> None:
    now = datetime.now(timezone.utc).isoformat()
    conn.executemany(
        "INSERT INTO context_templates (name, role_text, goal_text, created_at, updated_at) "
        "VALUES (?, ?, '', ?, ?)",
        [(name, role, now, now) for name, role in _BUILTIN_CONTEXT_TEMPLATES],
    )


def list_context_templates(path: str) -> list[dict]:
    """全部背景範本，依建立順序（內建 4 個在前）。"""
    with closing(_connect(path)) as conn:
        rows = conn.execute(
            "SELECT id, name, role_text, goal_text, updated_at "
            "FROM context_templates ORDER BY id"
        ).fetchall()
    return [dict(r) for r in rows]


def save_context_template(path: str, *, name: str, role_text: str, goal_text: str) -> int:
    """新增範本，回 id。名稱重複由 UNIQUE 約束丟 sqlite3.IntegrityError。"""
    now = datetime.now(timezone.utc).isoformat()
    with closing(_connect(path)) as conn:
        cur = conn.execute(
            "INSERT INTO context_templates (name, role_text, goal_text, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (name, role_text, goal_text, now, now),
        )
        conn.commit()
        return int(cur.lastrowid)


def update_context_template(
    path: str,
    template_id: int,
    *,
    name: str | object = _UNSET,
    role_text: str | object = _UNSET,
    goal_text: str | object = _UNSET,
) -> bool:
    """部分更新範本。不存在回 False；名稱撞 UNIQUE 丟 IntegrityError。"""
    sets: list[str] = []
    params: list = []
    for col, val in (("name", name), ("role_text", role_text), ("goal_text", goal_text)):
        if val is not _UNSET:
            sets.append(f"{col} = ?")
            params.append(val)
    if not sets:
        return False
    sets.append("updated_at = ?")
    params.append(datetime.now(timezone.utc).isoformat())
    params.append(template_id)
    with closing(_connect(path)) as conn:
        cur = conn.execute(
            f"UPDATE context_templates SET {', '.join(sets)} WHERE id = ?",
            params,
        )
        conn.commit()
        return cur.rowcount > 0


def delete_context_template(path: str, template_id: int) -> bool:
    """刪除範本，不存在回 False。"""
    with closing(_connect(path)) as conn:
        cur = conn.execute(
            "DELETE FROM context_templates WHERE id = ?", (template_id,)
        )
        conn.commit()
        return cur.rowcount > 0
