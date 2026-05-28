from __future__ import annotations

from pydantic import field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # 模型 / 裝置
    DEVICE: str = "auto"
    COMPUTE_TYPE: str = "int8"
    STREAM_MODEL: str = "phate334/Breeze-ASR-25-ct2"
    ASR_BACKEND: str = "faster-whisper"

    # 傳輸限制
    MAX_CHUNK_SIZE: int = 5 * 1024 * 1024  # 5 MB
    # CORS_ORIGINS 在 .env 以逗號分隔字串設定，由 _split_cors validator 轉為 list
    CORS_ORIGINS: str | list[str] = ["http://localhost:3000", "http://localhost:8081"]
    DEFAULT_LANGUAGE: str = "zh"

    # 前端 VAD（AudioProcessor RMS 能量門檻、靜音超時）
    FRONTEND_VAD_RMS_THRESHOLD: float = 300.0
    FRONTEND_VAD_SILENCE_TIMEOUT_S: float = 1.0

    # 後端 VAD（faster-whisper 過濾靜音段）
    BACKEND_VAD_ENABLED: bool = True
    BACKEND_VAD_THRESHOLD: float = 0.3
    BACKEND_VAD_SILENCE_MS: int = 300
    BACKEND_VAD_SPEECH_PAD_MS: int = 200

    # LLM 追問產製服務（OpenAI-compatible）
    LLM_BASE_URL: str = "http://llm:8001/v1"
    LLM_MODEL: str = "MediaTek-Research/Breeze-2-8B-Instruct"
    LLM_API_KEY: str = ""  # 本地自架 LLM 留空即可
    LLM_MAX_TOKENS: int = 1024
    LLM_TEMPERATURE: float = 0.2
    LLM_TIMEOUT: int = 240

    # SQLite 持久層
    LETSMEET_DB_PATH: str = "/data/letsmeet.db"

    # whisper.cpp HTTP 模式（設定後優先使用，否則使用 faster-whisper）
    WHISPER_CPP_URL: str = ""
    WHISPER_CPP_LANGUAGE: str = ""
    WHISPER_CPP_TIMEOUT: int = 30

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def _split_cors(cls, v: str | list[str]) -> list[str]:
        if isinstance(v, str):
            return [origin.strip() for origin in v.split(",")]
        return v

    @field_validator("WHISPER_CPP_LANGUAGE", mode="after")
    @classmethod
    def _default_whisper_cpp_language(cls, v: str, info) -> str:
        if not v:
            return info.data.get("DEFAULT_LANGUAGE", "zh")
        return v

    @field_validator("ASR_BACKEND", mode="after")
    @classmethod
    def _normalize_asr_backend(cls, v: str) -> str:
        backend = v.strip().lower()
        allowed = {"faster-whisper", "transformers"}
        if backend not in allowed:
            raise ValueError(f"ASR_BACKEND must be one of: {', '.join(sorted(allowed))}")
        return backend

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "case_sensitive": True,
        "extra": "ignore",
    }


settings = Settings()

# 模組級別匯出（維持與既有 import 相容）
DEVICE = settings.DEVICE
COMPUTE_TYPE = settings.COMPUTE_TYPE
STREAM_MODEL = settings.STREAM_MODEL
ASR_BACKEND = settings.ASR_BACKEND
MAX_CHUNK_SIZE = settings.MAX_CHUNK_SIZE
CORS_ORIGINS = settings.CORS_ORIGINS
DEFAULT_LANGUAGE = settings.DEFAULT_LANGUAGE

FRONTEND_VAD_RMS_THRESHOLD = settings.FRONTEND_VAD_RMS_THRESHOLD
FRONTEND_VAD_SILENCE_TIMEOUT_S = settings.FRONTEND_VAD_SILENCE_TIMEOUT_S

BACKEND_VAD_ENABLED = settings.BACKEND_VAD_ENABLED
BACKEND_VAD_THRESHOLD = settings.BACKEND_VAD_THRESHOLD
BACKEND_VAD_SILENCE_MS = settings.BACKEND_VAD_SILENCE_MS
BACKEND_VAD_SPEECH_PAD_MS = settings.BACKEND_VAD_SPEECH_PAD_MS

LLM_BASE_URL = settings.LLM_BASE_URL
LLM_MODEL = settings.LLM_MODEL
LLM_API_KEY = settings.LLM_API_KEY
LLM_MAX_TOKENS = settings.LLM_MAX_TOKENS
LLM_TEMPERATURE = settings.LLM_TEMPERATURE
LLM_TIMEOUT = settings.LLM_TIMEOUT

WHISPER_CPP_URL = settings.WHISPER_CPP_URL
WHISPER_CPP_LANGUAGE = settings.WHISPER_CPP_LANGUAGE
WHISPER_CPP_TIMEOUT = settings.WHISPER_CPP_TIMEOUT

DB_PATH = settings.LETSMEET_DB_PATH
