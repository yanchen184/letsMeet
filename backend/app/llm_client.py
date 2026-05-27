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

聚焦原則（最重要）：
- 問題要緊扣【最新發言】這段，那是對方「剛剛才講」的內容，也是現在最該追問的。
- 若逐字稿含【先前重點】或【前段重點摘要】，那只是脈絡背景，不要為了它生問題；
  只有當最新發言需要對照背景才看得懂時，才把背景當參考。
- 不要重問背景裡明顯已經釐清、或先前已經追問過的點。

去重原則（重要）：
- 若提供了【已問過的問題】清單，你產的每一題都必須是「新的角度」，
  不可與清單中任何一題相同或意思相近（換句話說、改個措辭但實質一樣也算重複）。
- 如果最新發言能追問的點都已經在清單裡了，寧可少問幾題、甚至只回最有價值的 1 題，
  也不要硬湊數量去重複既有問題。

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


USER_PROMPT_TEMPLATE = """以下是甲方的發言逐字稿：

---
{transcript}
---

請依照系統指示，**優先針對【最新發言】**，產出 3-5 個乙方該追問的問題。只輸出 JSON。"""


# 前端已切好「新行 + 舊摘要」時，把新行明確標成最新發言、舊摘要當背景脈絡
RECENT_WITH_PRIOR_TEMPLATE = """【先前重點】（背景脈絡，不要為它生問題）
{prior}

【最新發言】（對方剛講的，請聚焦這段提問）
{recent}"""


CONTEXT_BLOCK_TEMPLATE = """【本場會議背景】（乙方提供，請結合此背景判斷該追問什麼）
{context}

"""


ASKED_BLOCK_TEMPLATE = """【已問過的問題】（這些都問過了，請勿重複或產出意思相近的）
{asked}

"""


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

    context = RECENT_WITH_PRIOR_TEMPLATE.format(prior=summary, recent=recent)
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
    older_transcript: str | None = None,
    context_hint: str | None = None,
    asked_questions: list[str] | None = None,
) -> dict[str, Any]:
    """產生 3-5 個追問問題（聚焦最新發言）。

    Args:
        transcript: 要聚焦提問的逐字稿；增量模式下＝上次產問後的新行
        prior_summary: 前端帶回的「前段摘要」cache；有值直接當背景，省摘要 token
        older_transcript: 游標前已問過的舊原文；無 prior_summary 時由後端摘要成背景並回傳
        context_hint: 乙方提供的會議背景／角色提示；非空時注入 prompt 引導提問方向
        asked_questions: 畫面上已存在的問題文字清單；注入 prompt 叫 LLM 避免重複或近似

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
    has_prior = bool(prior_summary and prior_summary.strip())
    has_older = bool(older_transcript and older_transcript.strip())

    # 四種情境（依序判斷）：
    # 1) 有 prior_summary：增量模式，前端已 cache 舊摘要 → 直接當背景，新行＝最新發言，不再摘要
    # 2) 無 prior 但有 older_transcript：增量首批 → 摘要舊原文當背景並回傳 cache，新行＝最新發言
    # 3) 無 older 但 transcript 超長：全文模式，後端自切滑動視窗
    # 4) 無 older 且夠短：原文直送（系統 prompt 仍引導聚焦最新）
    new_summary: str | None = None
    if has_prior:
        context = RECENT_WITH_PRIOR_TEMPLATE.format(
            prior=prior_summary.strip(),
            recent=text,
        )
        truncated = True
    elif has_older:
        summary = await _summarize_async(older_transcript.strip())
        new_summary = summary
        context = RECENT_WITH_PRIOR_TEMPLATE.format(prior=summary, recent=text)
        truncated = True
    elif len(text) <= SUMMARY_TRIGGER_CHARS:
        context = text
        truncated = False
    else:
        recent = text[-WINDOW_RECENT_CHARS:]
        older = text[:-WINDOW_RECENT_CHARS]
        summary = await _summarize_async(older)
        new_summary = summary
        context = RECENT_WITH_PRIOR_TEMPLATE.format(prior=summary, recent=recent)
        truncated = True

    user_prompt = USER_PROMPT_TEMPLATE.format(transcript=context)

    # 已問過清單在前：去重指令在動筆前就被讀到
    asked_clean = [q.strip() for q in (asked_questions or []) if q and q.strip()]
    if asked_clean:
        asked_block = "\n".join(f"- {q}" for q in asked_clean)
        user_prompt = ASKED_BLOCK_TEMPLATE.format(asked=asked_block) + user_prompt

    if context_hint and context_hint.strip():
        user_prompt = CONTEXT_BLOCK_TEMPLATE.format(context=context_hint.strip()) + user_prompt
    raw = await _chat_completion(SYSTEM_PROMPT, user_prompt)
    questions = parse_questions_json(raw)

    return {
        "questions": questions,
        "summary": new_summary,
        "truncated": truncated,
    }
