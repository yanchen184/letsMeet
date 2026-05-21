"""config 單元測試：CORS validator、env 覆寫行為。"""

from __future__ import annotations

import pytest

from app.config import Settings


@pytest.mark.unit
class TestCorsOriginsValidator:
    def test_list_input_unchanged(self) -> None:
        s = Settings(CORS_ORIGINS=["http://a.com", "http://b.com"])
        assert s.CORS_ORIGINS == ["http://a.com", "http://b.com"]

    def test_comma_separated_string_is_split(self) -> None:
        s = Settings(CORS_ORIGINS="http://a.com,http://b.com")
        assert s.CORS_ORIGINS == ["http://a.com", "http://b.com"]

    def test_whitespace_is_trimmed(self) -> None:
        s = Settings(CORS_ORIGINS="http://a.com , http://b.com")
        assert s.CORS_ORIGINS == ["http://a.com", "http://b.com"]

    def test_wildcard_is_preserved(self) -> None:
        s = Settings(CORS_ORIGINS="*")
        assert s.CORS_ORIGINS == ["*"]

    def test_single_origin(self) -> None:
        s = Settings(CORS_ORIGINS="https://example.com")
        assert s.CORS_ORIGINS == ["https://example.com"]


@pytest.mark.unit
class TestWhisperCppLanguageDefault:
    def test_empty_language_falls_back_to_default(self) -> None:
        s = Settings(WHISPER_CPP_LANGUAGE="", DEFAULT_LANGUAGE="zh")
        assert s.WHISPER_CPP_LANGUAGE == "zh"

    def test_explicit_language_is_respected(self) -> None:
        s = Settings(WHISPER_CPP_LANGUAGE="en", DEFAULT_LANGUAGE="zh")
        assert s.WHISPER_CPP_LANGUAGE == "en"


@pytest.mark.unit
class TestAsrBackend:
    def test_default_backend_is_faster_whisper(self) -> None:
        s = Settings()
        assert s.ASR_BACKEND == "faster-whisper"

    def test_backend_is_normalized(self) -> None:
        s = Settings(ASR_BACKEND=" Transformers ")
        assert s.ASR_BACKEND == "transformers"

    def test_unknown_backend_raises(self) -> None:
        with pytest.raises(ValueError):
            Settings(ASR_BACKEND="unknown")


@pytest.mark.unit
class TestExtraEnvVarsIgnored:
    """.env 中的未知欄位不應導致 pydantic 啟動失敗。"""

    def test_extra_fields_do_not_raise(self) -> None:
        s = Settings(SOME_UNKNOWN_LEGACY_VAR="leftover")
        # 有讀到但不會報錯，且不會掛在 settings 上
        assert not hasattr(s, "SOME_UNKNOWN_LEGACY_VAR")
