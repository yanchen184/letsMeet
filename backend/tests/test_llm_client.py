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
        assert "【前段重點摘要】" in context
        assert "【最近原文】" in context
        # 最近原文應該是最後 WINDOW_RECENT_CHARS 字
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
