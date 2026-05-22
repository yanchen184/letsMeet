"""LLM 即時追問產製模組（乙方視角）。

流程（手動觸發，前端按下「生成問題」時呼叫）：
  1. 依累積逐字稿長度，決定是否啟動滑動視窗 + 摘要
  2. 組裝 prompt，呼叫 LLM 產生 3-5 個追問問題
  3. 回傳 {"questions": [{"q","why"}, ...], "summary": str|None, "truncated": bool}

設計原則：
- 無模組層級可變狀態
- 滑動視窗：transcript ≤ SUMMARY_TRIGGER_CHARS 直接送 LLM；否則拆「最近原文」+ 「前段摘要」
- 摘要可由前端 cache 帶回（prior_summary），省去重複摘要 token
- LLM 回傳 JSON 容錯：嚴格 parse → strip markdown 邊界後 parse → 否則拋 LLMOutputFormatError
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import httpx

from app.config import (
    LLM_API_KEY,
    LLM_BASE_URL,
    LLM_MAX_TOKENS,
    LLM_MODEL,
    LLM_TEMPERATURE,
    LLM_TIMEOUT,
)

logger = logging.getLogger(__name__)


# ── 滑動視窗常數 ───────────────────────────────────────────────────────────────

SUMMARY_TRIGGER_CHARS = 6000   # transcript 超此值才啟動摘要
WINDOW_RECENT_CHARS = 4000     # 最近原文保留字元數
SUMMARIZE_MAX_CHARS = 500      # 前段摘要上限提示給 LLM


# ── Prompts ───────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """你是一位資深的乙方專案經理，正在參與與甲方的會議。
你的任務：根據甲方剛才說的話（逐字稿），找出「現在該追問」的關鍵問題，
幫助乙方在會議當下釐清需求、降低後續執行風險。

提問原則（依優先序）：
1. 需求模糊：規格、驗收標準、定義不清的詞
2. 範圍未定：「之後再說」「再看看」「應該」這類保留語
3. 變更管理：誰能拍板、改了算誰的、流程是什麼
4. 時程與資源：里程碑、依賴方、何時給什麼
5. 費用相關：報價依據、額外費用、付款條件

輸出規範：
- 3 到 5 個問題
- 每題包含 q（要問什麼，口語化、可以直接念出來）
- 每題包含 why（為什麼該問，盡量引用對方原話片段）
- 嚴格 JSON 格式，不要 markdown 不要前後綴

輸出範例：
{
  "questions": [
    {
      "q": "您剛提到的『驗收標準』，目前是用哪幾個指標來判定？",
      "why": "對方說『驗收的時候我們再看』，但沒說標準"
    }
  ]
}
"""


USER_PROMPT_TEMPLATE = """以下是甲方剛才的發言逐字稿：

---
{transcript}
---

請依照系統指示，產出 3-5 個乙方該追問的問題。只輸出 JSON。"""


SUMMARIZE_SYSTEM_PROMPT = f"""你是會議紀錄助理。
請把以下逐字稿濃縮成 {SUMMARIZE_MAX_CHARS} 字內的條列要點，
保留：具體承諾、數字、時程、人名、待釐清項目。
不要客套話，不要加任何解釋。只輸出條列要點本身。"""


# ── Exceptions ────────────────────────────────────────────────────────────────

class LLMOutputFormatError(ValueError):
    """LLM 回傳的內容無法解析成預期的 JSON 結構。"""


# ── 滑動視窗 ──────────────────────────────────────────────────────────────────

def build_context(
    transcript: str,
    prior_summary: str | None = None,
) -> tuple[str, str | None, bool]:
    """依 transcript 長度決定是否啟動滑動視窗。

    Returns:
        (context, summary, truncated)
        - context: 真正送 LLM 的字串
        - summary: 若這次有產生新摘要則回傳；前端可 cache 下次帶回
        - truncated: 是否走了截斷
    """
    text = transcript or ""

    if len(text) <= SUMMARY_TRIGGER_CHARS:
        return text, None, False

    recent = text[-WINDOW_RECENT_CHARS:]
    older = text[:-WINDOW_RECENT_CHARS]

    if prior_summary and prior_summary.strip():
        summary = prior_summary.strip()
        new_summary_for_cache: str | None = None
    else:
        summary = _summarize_sync_placeholder(older)
        new_summary_for_cache = summary

    context = f"【前段重點摘要】\n{summary}\n\n【最近原文】\n{recent}"
    return context, new_summary_for_cache, True


def _summarize_sync_placeholder(older: str) -> str:
    """同步包裝；實際呼叫由 generate_questions 的 async 路徑用 _summarize_async。

    這支 helper 之所以存在，是為了讓 build_context 能在純 unit test 中（不打 LLM）
    回傳可預期的字串。Integration 路徑會繞過它直接呼叫 _summarize_async。
    """
    return f"(尚未摘要的前段 {len(older)} 字)"


# ── LLM 呼叫 ──────────────────────────────────────────────────────────────────

async def _chat_completion(
    system: str,
    user: str,
    *,
    temperature: float | None = None,
    max_tokens: int | None = None,
) -> str:
    """OpenAI-compatible chat completion 呼叫。回傳純文字 content。"""
    headers = {"Content-Type": "application/json"}
    if LLM_API_KEY:
        headers["Authorization"] = f"Bearer {LLM_API_KEY}"

    payload = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": LLM_TEMPERATURE if temperature is None else temperature,
        "max_tokens": LLM_MAX_TOKENS if max_tokens is None else max_tokens,
    }

    url = f"{LLM_BASE_URL.rstrip('/')}/chat/completions"
    async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()

    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise LLMOutputFormatError(
            f"LLM response missing choices[0].message.content: {data!r}"
        ) from exc


async def _summarize_async(older: str) -> str:
    """把前段逐字稿濃縮成 ≤ SUMMARIZE_MAX_CHARS 字的條列摘要。"""
    if not older.strip():
        return ""
    content = await _chat_completion(
        SUMMARIZE_SYSTEM_PROMPT,
        older,
        temperature=0.1,
        max_tokens=800,
    )
    return content.strip()


# ── JSON 容錯解析 ─────────────────────────────────────────────────────────────

_MARKDOWN_FENCE_RE = re.compile(
    r"^\s*```(?:json)?\s*\n?(.*?)\n?\s*```\s*$",
    re.DOTALL | re.IGNORECASE,
)


def parse_questions_json(raw: str) -> list[dict[str, str]]:
    """把 LLM 回傳的字串解析成 questions list。

    嚴格 → strip markdown fences → 失敗就拋 LLMOutputFormatError。
    回傳的每個 element 至少包含 q 與 why 兩個 key。
    """
    if not raw or not raw.strip():
        raise LLMOutputFormatError("LLM returned empty content")

    candidates = [raw.strip()]
    fence_match = _MARKDOWN_FENCE_RE.match(raw.strip())
    if fence_match:
        candidates.append(fence_match.group(1).strip())
    # 再退一步：找 raw 內第一個 {...} 區塊
    brace_match = re.search(r"\{.*\}", raw, re.DOTALL)
    if brace_match:
        candidates.append(brace_match.group(0))

    last_err: Exception | None = None
    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError as exc:
            last_err = exc
            continue
        questions = data.get("questions") if isinstance(data, dict) else None
        if not isinstance(questions, list) or not questions:
            last_err = LLMOutputFormatError(f"questions missing or empty: {data!r}")
            continue
        cleaned: list[dict[str, str]] = []
        for item in questions:
            if not isinstance(item, dict):
                continue
            q = str(item.get("q", "")).strip()
            why = str(item.get("why", "")).strip()
            if q:
                cleaned.append({"q": q, "why": why})
        if cleaned:
            return cleaned
        last_err = LLMOutputFormatError(f"no valid question items in: {data!r}")

    raise LLMOutputFormatError(f"failed to parse LLM output: {last_err}") from last_err


# ── 對外主入口 ────────────────────────────────────────────────────────────────

async def generate_questions(
    transcript: str,
    prior_summary: str | None = None,
) -> dict[str, Any]:
    """產生 3-5 個追問問題。

    Args:
        transcript: 累積的甲方逐字稿（單一字串）
        prior_summary: 前端帶回的「前段摘要」cache；省去重新摘要的 token

    Returns:
        {
          "questions": [{"q","why"}, ...],
          "summary": str | None,    # 本次有新產出摘要才會有值，前端應 cache
          "truncated": bool,        # 是否走了滑動視窗
        }

    Raises:
        ValueError: transcript 為空
        LLMOutputFormatError: LLM 輸出無法解析
        httpx.HTTPError: LLM 服務通訊失敗
    """
    if not transcript or not transcript.strip():
        raise ValueError("transcript 不可為空")

    text = transcript.strip()

    # 滑動視窗（async 版，跟 build_context 的差異是這裡會真的呼叫 LLM 摘要）
    if len(text) <= SUMMARY_TRIGGER_CHARS:
        context = text
        new_summary: str | None = None
        truncated = False
    else:
        recent = text[-WINDOW_RECENT_CHARS:]
        older = text[:-WINDOW_RECENT_CHARS]
        if prior_summary and prior_summary.strip():
            summary = prior_summary.strip()
            new_summary = None
        else:
            summary = await _summarize_async(older)
            new_summary = summary
        context = f"【前段重點摘要】\n{summary}\n\n【最近原文】\n{recent}"
        truncated = True

    user_prompt = USER_PROMPT_TEMPLATE.format(transcript=context)
    raw = await _chat_completion(SYSTEM_PROMPT, user_prompt)
    questions = parse_questions_json(raw)

    return {
        "questions": questions,
        "summary": new_summary,
        "truncated": truncated,
    }
