from __future__ import annotations

import logging

import httpx

from app.config import WHISPER_CPP_LANGUAGE, WHISPER_CPP_TIMEOUT, WHISPER_CPP_URL

logger = logging.getLogger(__name__)


async def transcribe(wav_bytes: bytes, language: str | None = None) -> str:
    """將 WAV bytes 送至 whisper.cpp HTTP API，回傳轉錄文字。

    Args:
        wav_bytes: 16kHz mono PCM WAV 音訊資料。
        language:  語言代碼（例如 "zh"），None 則使用設定值。

    Returns:
        轉錄文字，失敗時回傳空字串。
    """
    lang = language or WHISPER_CPP_LANGUAGE or "zh"
    try:
        async with httpx.AsyncClient(timeout=WHISPER_CPP_TIMEOUT) as client:
            resp = await client.post(
                WHISPER_CPP_URL,
                files={"file": ("audio.wav", wav_bytes, "audio/wav")},
                data={
                    "language": lang,
                    "response_format": "json",
                    "temperature": "0.0",
                    "temperature_inc": "0.2",
                    "translate": "false",
                    "beam_size": "5",
                },
            )
            resp.raise_for_status()
            return resp.json().get("text", "").strip()
    except httpx.HTTPStatusError as e:
        logger.warning("whisper.cpp HTTP 狀態錯誤: %s %s", e.response.status_code, e.request.url)
        return ""
    except httpx.TimeoutException:
        logger.warning("whisper.cpp 呼叫逾時 (timeout=%ss)", WHISPER_CPP_TIMEOUT)
        return ""
    except httpx.HTTPError as e:
        logger.warning("whisper.cpp HTTP 錯誤: %s", e)
        return ""
    except Exception:
        logger.exception("whisper.cpp 呼叫失敗（非預期錯誤）")
        return ""
