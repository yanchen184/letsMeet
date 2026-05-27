"""llm_client 單元測試：滑動視窗、JSON 容錯、generate_questions 行為。"""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from app.llm_client import (
    LLMOutputFormatError,
    SUMMARIZE_MAX_CHARS,
    SUMMARY_TRIGGER_CHARS,
    WINDOW_RECENT_CHARS,
    build_context,
    generate_questions,
    parse_questions_json,
)


# ── build_context（sync 版） ──────────────────────────────────────────────────


@pytest.mark.unit
class TestBuildContext:
    def test_short_transcript_passes_through_untouched(self) -> None:
        text = "甲方說我們希望兩週內 demo。"
        context, summary, truncated = build_context(text)
        assert context == text
        assert summary is None
        assert truncated is False

    def test_long_transcript_triggers_truncation_without_prior_summary(self) -> None:
        text = "甲" * (SUMMARY_TRIGGER_CHARS + 100)
        context, summary, truncated = build_context(text, prior_summary=None)
        assert truncated is True
        assert "【先前重點】" in context
        assert "【最新發言】" in context
        # 最新發言應該是最後 WINDOW_RECENT_CHARS 字
        assert context.endswith("甲" * WINDOW_RECENT_CHARS)
        # build_context 是 sync placeholder，不會真打 LLM
        assert summary is not None and "尚未摘要" in summary

    def test_long_transcript_uses_prior_summary_when_provided(self) -> None:
        text = "甲" * (SUMMARY_TRIGGER_CHARS + 100)
        prior = "甲方先前主要在談時程與費用。"
        context, summary, truncated = build_context(text, prior_summary=prior)
        assert truncated is True
        assert prior in context
        # 用了 prior_summary 就不會回傳新摘要（前端不用更新 cache）
        assert summary is None


# ── parse_questions_json ──────────────────────────────────────────────────────


@pytest.mark.unit
class TestParseQuestionsJson:
    def test_pure_json(self) -> None:
        raw = json.dumps({
            "questions": [
                {"q": "驗收標準是？", "why": "對方未說明"},
                {"q": "誰能拍板？", "why": "對方說『回去問』"},
            ]
        })
        items = parse_questions_json(raw)
        assert len(items) == 2
        assert items[0]["q"] == "驗收標準是？"
        assert items[1]["why"] == "對方說『回去問』"

    def test_markdown_fenced_json(self) -> None:
        raw = "```json\n" + json.dumps({
            "questions": [{"q": "費用如何計算？", "why": "未提報價依據"}]
        }) + "\n```"
        items = parse_questions_json(raw)
        assert items == [{"q": "費用如何計算？", "why": "未提報價依據"}]

    def test_extracts_first_brace_block_when_extra_prose(self) -> None:
        raw = (
            "好的，這是我為您整理的問題：\n"
            + json.dumps({"questions": [{"q": "時程？", "why": "未定"}]})
            + "\n希望有幫助。"
        )
        items = parse_questions_json(raw)
        assert items == [{"q": "時程？", "why": "未定"}]

    def test_drops_items_without_q(self) -> None:
        raw = json.dumps({
            "questions": [
                {"q": "", "why": "空 q 應該被丟掉"},
                {"q": "合法問題", "why": ""},
            ]
        })
        items = parse_questions_json(raw)
        assert items == [{"q": "合法問題", "why": ""}]

    def test_raises_on_empty_input(self) -> None:
        with pytest.raises(LLMOutputFormatError):
            parse_questions_json("")
        with pytest.raises(LLMOutputFormatError):
            parse_questions_json("   \n  ")

    def test_raises_on_unparseable(self) -> None:
        with pytest.raises(LLMOutputFormatError):
            parse_questions_json("this is not json at all")

    def test_raises_on_missing_questions_key(self) -> None:
        with pytest.raises(LLMOutputFormatError):
            parse_questions_json(json.dumps({"foo": "bar"}))

    def test_raises_on_all_items_invalid(self) -> None:
        with pytest.raises(LLMOutputFormatError):
            parse_questions_json(json.dumps({"questions": [{"q": "", "why": ""}]}))


# ── generate_questions（async，mock LLM） ─────────────────────────────────────


@pytest.mark.unit
@pytest.mark.asyncio
class TestGenerateQuestions:
    async def test_short_transcript_does_not_summarize(self) -> None:
        """transcript < SUMMARY_TRIGGER_CHARS → 只呼叫一次 chat_completion（問題生成），不摘要。"""
        async def fake_chat(system, user, **kwargs):
            return json.dumps({
                "questions": [
                    {"q": "驗收標準？", "why": "未說明"},
                    {"q": "時程？", "why": "未定"},
                    {"q": "費用？", "why": "未報"},
                ]
            })

        with patch("app.llm_client._chat_completion", side_effect=fake_chat) as mock_chat:
            result = await generate_questions("甲方說我們再看")

        assert result["truncated"] is False
        assert result["summary"] is None
        assert len(result["questions"]) == 3
        assert mock_chat.call_count == 1

    async def test_long_transcript_summarizes_when_no_prior(self) -> None:
        """transcript > trigger 且無 prior_summary → 呼叫 2 次：summarize + generate。"""
        calls: list[str] = []

        async def fake_chat(system, user, **kwargs):
            calls.append(system)
            if "會議紀錄助理" in system:
                return "- 甲方要求兩週內 demo\n- 預算未明"
            return json.dumps({"questions": [{"q": "預算上限？", "why": "前段提及"}]})

        with patch("app.llm_client._chat_completion", side_effect=fake_chat):
            long_text = "甲" * (SUMMARY_TRIGGER_CHARS + 100)
            result = await generate_questions(long_text, prior_summary=None)

        assert result["truncated"] is True
        assert result["summary"] == "- 甲方要求兩週內 demo\n- 預算未明"
        assert len(calls) == 2  # 摘要 + 生成

    async def test_long_transcript_skips_summarize_when_prior_summary_given(self) -> None:
        """有 prior_summary → 只呼叫 1 次（generate）。"""
        async def fake_chat(system, user, **kwargs):
            assert "會議紀錄助理" not in system, "不應該再呼叫摘要"
            return json.dumps({"questions": [{"q": "X？", "why": "Y"}]})

        with patch("app.llm_client._chat_completion", side_effect=fake_chat) as mock_chat:
            long_text = "甲" * (SUMMARY_TRIGGER_CHARS + 100)
            result = await generate_questions(
                long_text, prior_summary="先前已摘要"
            )

        assert result["truncated"] is True
        assert result["summary"] is None  # 用了 cache，沒新摘要要回給前端
        assert mock_chat.call_count == 1

    async def test_prior_summary_marks_transcript_as_recent_without_resummarizing(self) -> None:
        """增量產問：帶 prior_summary 時，新行原文標為【最新發言】、舊摘要當背景，且不重新摘要。"""
        captured: dict[str, str] = {}

        async def fake_chat(system, user, **kwargs):
            assert "會議紀錄助理" not in system, "有 prior_summary 不該再摘要"
            captured["user"] = user
            return json.dumps({"questions": [{"q": "X？", "why": "Y"}]})

        with patch("app.llm_client._chat_completion", side_effect=fake_chat) as mock_chat:
            result = await generate_questions(
                "甲方剛剛說驗收的事再看",        # 短新行
                prior_summary="- 前段談過時程\n- 預算未定",
            )

        assert mock_chat.call_count == 1  # 只生成，不摘要
        assert result["truncated"] is True
        assert result["summary"] is None
        # 新行原文出現在【最新發言】、舊摘要出現在【先前重點】
        assert "【最新發言】" in captured["user"]
        assert "【先前重點】" in captured["user"]
        assert "甲方剛剛說驗收的事再看" in captured["user"]
        assert "前段談過時程" in captured["user"]
        # 順序：先前重點在最新發言之前
        assert captured["user"].index("【先前重點】") < captured["user"].index("【最新發言】")

    async def test_older_transcript_summarized_into_background_and_cached(self) -> None:
        """增量首批：無 prior 但有 older_transcript → 摘要 older 當背景 + 回傳 summary 供 cache。"""
        calls: list[str] = []
        captured: dict[str, str] = {}

        async def fake_chat(system, user, **kwargs):
            calls.append(system)
            if "會議紀錄助理" in system:
                return "- 舊段:談過交期"
            captured["user"] = user
            return json.dumps({"questions": [{"q": "X？", "why": "Y"}]})

        with patch("app.llm_client._chat_completion", side_effect=fake_chat):
            result = await generate_questions(
                "甲方剛說預算只有五十萬",     # 新行
                prior_summary=None,
                older_transcript="一堆已經問過的舊內容",
            )

        assert len(calls) == 2  # 摘要 older + 生成
        assert result["truncated"] is True
        assert result["summary"] == "- 舊段:談過交期"  # 回傳供前端 cache
        assert "【最新發言】" in captured["user"]
        assert "甲方剛說預算只有五十萬" in captured["user"]
        assert "舊段:談過交期" in captured["user"]

    async def test_prior_summary_wins_over_older_transcript(self) -> None:
        """同時有 prior_summary 和 older_transcript → 用 cache,不重新摘要(省 token)。"""
        async def fake_chat(system, user, **kwargs):
            assert "會議紀錄助理" not in system, "已有 cache 不該再摘要"
            return json.dumps({"questions": [{"q": "X？", "why": "Y"}]})

        with patch("app.llm_client._chat_completion", side_effect=fake_chat) as mock_chat:
            result = await generate_questions(
                "新行內容",
                prior_summary="已 cache 的摘要",
                older_transcript="這段應該被忽略",
            )
        assert mock_chat.call_count == 1
        assert result["summary"] is None

    async def test_user_prompt_instructs_focus_on_recent(self) -> None:
        """user prompt 含『優先針對【最新發言】』的聚焦指令。"""
        captured: dict[str, str] = {}

        async def fake_chat(system, user, **kwargs):
            captured["user"] = user
            return json.dumps({"questions": [{"q": "X？", "why": "Y"}]})

        with patch("app.llm_client._chat_completion", side_effect=fake_chat):
            await generate_questions("甲方說我們再看")
        assert "最新發言" in captured["user"]

    async def test_context_hint_injected_into_user_prompt(self) -> None:
        """有 context_hint → user prompt 含背景區塊;無則不含。"""
        captured: dict[str, str] = {}

        async def fake_chat(system, user, **kwargs):
            captured["user"] = user
            return json.dumps({"questions": [{"q": "X？", "why": "Y"}]})

        with patch("app.llm_client._chat_completion", side_effect=fake_chat):
            await generate_questions("甲方說我們再看", context_hint="我是採購方，重點在價格與交期")
        assert "【本場會議背景】" in captured["user"]
        assert "採購方" in captured["user"]

    async def test_no_context_hint_omits_background_block(self) -> None:
        async def fake_chat(system, user, **kwargs):
            assert "【本場會議背景】" not in user
            return json.dumps({"questions": [{"q": "X？", "why": "Y"}]})

        with patch("app.llm_client._chat_completion", side_effect=fake_chat):
            await generate_questions("甲方說我們再看")
        # 空字串也視同無背景
        with patch("app.llm_client._chat_completion", side_effect=fake_chat):
            await generate_questions("甲方說我們再看", context_hint="   ")

    async def test_asked_questions_injected_into_user_prompt(self) -> None:
        """有 asked_questions → user prompt 含『已問過的問題』清單,每題逐條列出。"""
        captured: dict[str, str] = {}

        async def fake_chat(system, user, **kwargs):
            captured["user"] = user
            return json.dumps({"questions": [{"q": "新角度？", "why": "Y"}]})

        with patch("app.llm_client._chat_completion", side_effect=fake_chat):
            await generate_questions(
                "甲方說驗收再看",
                asked_questions=["驗收標準是什麼？", "交期能否提前？"],
            )
        assert "【已問過的問題】" in captured["user"]
        assert "驗收標準是什麼？" in captured["user"]
        assert "交期能否提前？" in captured["user"]

    async def test_empty_asked_questions_omits_block(self) -> None:
        """asked_questions 為 None / 空 / 全空白 → 不注入清單區塊。"""
        async def fake_chat(system, user, **kwargs):
            assert "【已問過的問題】" not in user
            return json.dumps({"questions": [{"q": "X？", "why": "Y"}]})

        with patch("app.llm_client._chat_completion", side_effect=fake_chat):
            await generate_questions("甲方說我們再看")
        with patch("app.llm_client._chat_completion", side_effect=fake_chat):
            await generate_questions("甲方說我們再看", asked_questions=[])
        with patch("app.llm_client._chat_completion", side_effect=fake_chat):
            await generate_questions("甲方說我們再看", asked_questions=["  ", ""])

    async def test_system_prompt_instructs_dedup(self) -> None:
        """系統 prompt 含去重指令。"""
        captured: dict[str, str] = {}

        async def fake_chat(system, user, **kwargs):
            captured["system"] = system
            return json.dumps({"questions": [{"q": "X？", "why": "Y"}]})

        with patch("app.llm_client._chat_completion", side_effect=fake_chat):
            await generate_questions("甲方說我們再看")
        assert "去重原則" in captured["system"]

    async def test_empty_transcript_raises(self) -> None:
        with pytest.raises(ValueError):
            await generate_questions("")
        with pytest.raises(ValueError):
            await generate_questions("   \n  ")

    async def test_bad_llm_output_raises_format_error(self) -> None:
        async def fake_chat(system, user, **kwargs):
            return "definitely not json"

        with patch("app.llm_client._chat_completion", side_effect=fake_chat):
            with pytest.raises(LLMOutputFormatError):
                await generate_questions("甲方說我們再看")


# ── 模組常數合理性 ────────────────────────────────────────────────────────────


@pytest.mark.unit
def test_window_constants_are_sensible() -> None:
    """避免日後有人手滑把 recent 設得比 trigger 還大。"""
    assert WINDOW_RECENT_CHARS < SUMMARY_TRIGGER_CHARS
    assert SUMMARIZE_MAX_CHARS > 0
