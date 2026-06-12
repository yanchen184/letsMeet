"""HTTP / WebSocket 路由。

- WS /api/stream       即時語音轉錄（PCM16 → 文字）
- POST /api/questions  以乙方視角，從逐字稿產生 3-5 個追問
- GET /api/health      健康檢查
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.audio_processor import AudioProcessor
from app.config import (
    BACKEND_VAD_ENABLED,
    BACKEND_VAD_SILENCE_MS,
    BACKEND_VAD_SPEECH_PAD_MS,
    BACKEND_VAD_THRESHOLD,
    ASR_BACKEND,
    COMPUTE_TYPE,
    DB_PATH,
    DEFAULT_LANGUAGE,
    DEVICE,
    STREAM_MODEL,
    WHISPER_CPP_URL,
)
from app.llm_client import (
    LLMOutputFormatError,
    build_chat_messages,
    generate_questions,
    stream_chat,
    summarize,
)
from app.whisper_client import transcribe as whisper_cpp_transcribe
from app import db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


# ──────────────────────────────────────────
# ASR 單例
# ──────────────────────────────────────────
_stream_model: Any = None
_model_lock = threading.Lock()


def _get_stream_model() -> Any:  # pragma: no cover - 真模型載入屬 integration smoke
    """Double-checked locking 取得 ASR backend 單例。"""
    global _stream_model
    if _stream_model is not None:
        return _stream_model
    with _model_lock:
        if _stream_model is not None:
            return _stream_model
        if ASR_BACKEND == "transformers":
            _stream_model = _load_transformers_model()
            return _stream_model

        from faster_whisper import WhisperModel  # 僅在需要時載入

        device = DEVICE
        compute_type = COMPUTE_TYPE
        if device == "auto":
            try:
                import ctranslate2

                device = "cuda" if "cuda" in ctranslate2.get_supported_compute_types("cuda") else "cpu"
            except Exception:
                device = "cpu"
        if device == "cuda" and compute_type == "int8":
            compute_type = "float16"
        logger.info("Loading model=%s device=%s compute_type=%s", STREAM_MODEL, device, compute_type)
        _stream_model = WhisperModel(STREAM_MODEL, device=device, compute_type=compute_type)
    return _stream_model


def _load_transformers_model() -> dict[str, Any]:  # pragma: no cover - 需要 torch + transformers
    """載入 PyTorch/Transformers Whisper 模型。"""
    import torch
    from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor

    device = DEVICE
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32

    logger.info("Loading transformers model=%s device=%s dtype=%s", STREAM_MODEL, device, dtype)
    processor = AutoProcessor.from_pretrained(STREAM_MODEL)
    model = AutoModelForSpeechSeq2Seq.from_pretrained(
        STREAM_MODEL,
        torch_dtype=dtype,
        low_cpu_mem_usage=True,
        use_safetensors=True,
    ).to(device)
    model.eval()
    return {"backend": "transformers", "model": model, "processor": processor, "device": device, "dtype": dtype}


# ──────────────────────────────────────────
# HTTP endpoints
# ──────────────────────────────────────────


class QuestionsRequest(BaseModel):
    transcript: str = Field(..., description="要聚焦提問的逐字稿（增量模式下＝上次產問後的新行）")
    prior_summary: str | None = Field(
        default=None,
        description="前端帶回的『前段摘要』cache；有值時直接當背景，省去重新摘要的 token",
    )
    older_transcript: str | None = Field(
        default=None,
        description="游標前『已問過』的舊逐字稿原文；無 prior_summary 時由後端摘要成背景並回傳供前端 cache",
    )
    context: str | None = Field(
        default=None,
        description="乙方提供的會議背景／角色提示；引導 AI 提問方向",
    )
    asked_questions: list[str] | None = Field(
        default=None,
        description="畫面上已存在的問題文字清單；注入 prompt 讓 AI 避免產出重複或近似的問題",
    )


@router.post("/questions", response_model=None)
async def questions(req: QuestionsRequest) -> JSONResponse:
    """從逐字稿產生 3-5 個乙方視角的追問問題。"""
    request_id = uuid.uuid4().hex
    started = time.perf_counter()

    if not (req.transcript or "").strip():
        return JSONResponse(
            {"error": "transcript 不可為空"},
            status_code=422,
            headers={"X-Request-Id": request_id},
        )

    try:
        result = await generate_questions(
            req.transcript,
            prior_summary=req.prior_summary,
            older_transcript=req.older_transcript,
            context_hint=req.context,
            asked_questions=req.asked_questions,
        )
    except LLMOutputFormatError as exc:
        logger.warning("LLM output parse failed [%s]: %s", request_id, exc)
        return JSONResponse(
            {"error": "LLM 輸出格式錯誤，請重試"},
            status_code=502,
            headers={"X-Request-Id": request_id},
        )
    except httpx.TimeoutException:
        logger.exception("LLM timeout [%s]", request_id)
        return JSONResponse(
            {"error": "LLM 回應超時，請稍後再試"},
            status_code=504,
            headers={"X-Request-Id": request_id},
        )
    except httpx.HTTPError as exc:
        logger.exception("LLM HTTP error [%s]: %s", request_id, exc)
        return JSONResponse(
            {"error": "LLM 服務暫時不可用"},
            status_code=502,
            headers={"X-Request-Id": request_id},
        )

    latency_ms = int((time.perf_counter() - started) * 1000)
    logger.info(
        "questions ok [%s] transcript_chars=%d truncated=%s latency_ms=%d",
        request_id,
        len(req.transcript),
        result["truncated"],
        latency_ms,
    )

    return JSONResponse(
        {
            "questions": result["questions"],
            "summary": result["summary"],
            "truncated": result["truncated"],
        },
        headers={"X-Request-Id": request_id},
    )


class DigestRequest(BaseModel):
    transcript: str = Field(..., description="要壓成條列重點的一段逐字稿")


@router.post("/digest", response_model=None)
async def digest(req: DigestRequest) -> JSONResponse:
    """把一段逐字稿壓成條列重點摘要（產問時前端順手呼叫，原文折疊只看摘要）。"""
    request_id = uuid.uuid4().hex
    if not (req.transcript or "").strip():
        return JSONResponse(
            {"error": "transcript 不可為空"},
            status_code=422,
            headers={"X-Request-Id": request_id},
        )
    try:
        summary = await summarize(req.transcript)
    except httpx.TimeoutException:
        logger.exception("digest LLM timeout [%s]", request_id)
        return JSONResponse(
            {"error": "摘要回應超時，請稍後再試"},
            status_code=504,
            headers={"X-Request-Id": request_id},
        )
    except httpx.HTTPError as exc:
        logger.exception("digest LLM HTTP error [%s]: %s", request_id, exc)
        return JSONResponse(
            {"error": "摘要服務暫時不可用"},
            status_code=502,
            headers={"X-Request-Id": request_id},
        )
    return JSONResponse({"summary": summary}, headers={"X-Request-Id": request_id})


class MeetingSaveRequest(BaseModel):
    title: str = Field(..., description="會議標題")
    owner: str = Field(..., description="填寫者 / 歸誰")
    context: str | None = Field(default=None, description="當時會議背景")
    summary: str | None = Field(default=None, description="重點摘要")
    transcript: str | None = Field(default=None, description="完整原始逐字稿")
    questions: list[dict] | None = Field(default=None, description="產出追問")
    pin_code: str | None = Field(default=None, description="選填 4 位數字 PIN，由建立者自設")


@router.post("/meetings", response_model=None)
async def save_meeting_endpoint(req: MeetingSaveRequest) -> JSONResponse:
    """存一場會議記錄（摘要＋逐字稿＋追問）。"""
    request_id = uuid.uuid4().hex
    if not (req.title or "").strip() or not (req.owner or "").strip():
        return JSONResponse(
            {"error": "title 與 owner 不可為空"},
            status_code=422,
            headers={"X-Request-Id": request_id},
        )
    pin = (req.pin_code or "").strip() or None
    if pin is not None and not re.fullmatch(r"\d{4}", pin):
        return JSONResponse(
            {"error": "pin_code 須為 4 位數字"},
            status_code=422,
            headers={"X-Request-Id": request_id},
        )
    mid = db.save_meeting(
        DB_PATH,
        title=req.title.strip(),
        owner=req.owner.strip(),
        context=req.context,
        summary=req.summary,
        transcript=req.transcript,
        questions=req.questions,
        pin_code=pin,
    )
    logger.info("meeting saved [%s] id=%d owner=%s", request_id, mid, req.owner)
    return JSONResponse({"id": mid}, headers={"X-Request-Id": request_id})


@router.get("/meetings", response_model=None)
async def list_meetings_endpoint(owner: str | None = None) -> JSONResponse:
    """歷史會議列表（輕量欄位），owner 可選。"""
    request_id = uuid.uuid4().hex
    rows = db.list_meetings(DB_PATH, owner=owner)
    return JSONResponse({"meetings": rows}, headers={"X-Request-Id": request_id})


@router.get("/meetings/{meeting_id}", response_model=None)
async def get_meeting_endpoint(meeting_id: int, pin: str | None = None) -> JSONResponse:
    """單場會議完整內容。設了 PIN 的場次需帶 ?pin= 比對，缺/錯回 401。"""
    request_id = uuid.uuid4().hex
    meeting = db.get_meeting(DB_PATH, meeting_id)
    if meeting is None:
        return JSONResponse(
            {"error": "找不到該場會議"},
            status_code=404,
            headers={"X-Request-Id": request_id},
        )
    stored_pin = meeting.pop("pin_code", None)  # 不論如何都不外洩 pin
    if stored_pin:
        if (pin or "").strip() != stored_pin:
            return JSONResponse(
                {"error": "PIN 錯誤或未提供", "pin_required": True},
                status_code=401,
                headers={"X-Request-Id": request_id},
            )
    return JSONResponse(meeting, headers={"X-Request-Id": request_id})


class ChatRequest(BaseModel):
    messages: list[dict[str, str]] = Field(..., description="對話歷史 [{role, content}]，最後一則為使用者本次發問")
    transcript: str | None = Field(default=None, description="目前累積逐字稿全文，當回答脈絡")
    context: str | None = Field(default=None, description="會議背景／角色提示")
    asked_questions: list[str] | None = Field(default=None, description="已產生的追問問題清單")


@router.post("/chat", response_model=None)
async def chat(req: ChatRequest) -> StreamingResponse | JSONResponse:
    """與 AI 即時對談（SSE streaming）。逐 token 以 `data:` 推回前端。

    SSE 串流不便用 HTTP 狀態碼回錯誤；連線後的錯誤改以 `data: {"error": ...}` 推出。
    """
    request_id = uuid.uuid4().hex
    if not req.messages or not any((m.get("content") or "").strip() for m in req.messages):
        return JSONResponse(
            {"error": "messages 不可為空"},
            status_code=422,
            headers={"X-Request-Id": request_id},
        )

    chat_messages = build_chat_messages(
        req.messages,
        transcript=req.transcript,
        context_hint=req.context,
        asked_questions=req.asked_questions,
    )

    async def _event_stream() -> Any:
        try:
            async for delta in stream_chat(chat_messages):
                yield f"data: {json.dumps({'delta': delta}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        except httpx.TimeoutException:
            logger.exception("chat LLM timeout [%s]", request_id)
            yield f"data: {json.dumps({'error': 'AI 回應超時'}, ensure_ascii=False)}\n\n"
        except httpx.HTTPError as exc:
            logger.exception("chat LLM HTTP error [%s]: %s", request_id, exc)
            yield f"data: {json.dumps({'error': 'AI 服務暫時不可用'}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        _event_stream(),
        media_type="text/event-stream",
        headers={
            "X-Request-Id": request_id,
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/health", response_model=None)
async def health() -> JSONResponse:
    """健康檢查：確認 Whisper 後端已就緒。"""
    if not WHISPER_CPP_URL and _stream_model is None:
        return JSONResponse({"status": "loading"}, status_code=503)
    backend = "whisper.cpp" if WHISPER_CPP_URL else ASR_BACKEND
    return JSONResponse({"status": "ok", "backend": backend, "model": STREAM_MODEL})


# ──────────────────────────────────────────
# WebSocket /api/stream
#
# 前端協定：
#   送出：raw PCM16 LE, 16kHz, mono, 30ms/包（binary）
#   接收：
#     { "type": "connected" }
#     { "type": "processing" }
#     { "type": "transcription", "text": "..." }
#     { "type": "error", "message": "..." }
# ──────────────────────────────────────────

_WAV_MIN_BYTES = 1000


@router.websocket("/stream")
async def websocket_stream(ws: WebSocket) -> None:
    """即時語音串流轉錄 WebSocket 端點。"""
    await ws.accept()
    await ws.send_json({"type": "connected", "message": "WebSocket 已連接"})

    processor = AudioProcessor()

    async def _poll_and_transcribe() -> None:
        """每 200ms 輪詢一次，觸發轉錄並回傳結果。"""
        while True:
            await asyncio.sleep(0.2)
            if not processor.should_process():
                continue

            wav = processor.get_wav_bytes()
            processor.clear()

            if not wav or len(wav) < _WAV_MIN_BYTES:
                continue

            await ws.send_json({"type": "processing"})
            try:
                text = await _transcribe(wav)
                if text:
                    await ws.send_json({"type": "transcription", "text": text})
            except Exception:
                logger.exception("轉錄失敗")
                await ws.send_json({"type": "error", "message": "轉錄失敗，請重試"})

    poll_task = asyncio.create_task(_poll_and_transcribe())

    try:
        while True:
            msg = await ws.receive()
            if "bytes" in msg and msg["bytes"]:
                processor.add_frame(msg["bytes"])
    except WebSocketDisconnect:
        logger.info("Client disconnected")
    except asyncio.CancelledError:
        logger.info("WebSocket task cancelled")
    except Exception:
        logger.exception("WebSocket 非預期錯誤")
        try:
            await ws.send_json({"type": "error", "message": "伺服器內部錯誤"})
        except Exception:
            pass
    finally:
        poll_task.cancel()
        try:
            await poll_task
        except asyncio.CancelledError:
            pass


# ──────────────────────────────────────────
# 轉錄策略
# ──────────────────────────────────────────


async def _transcribe(wav_bytes: bytes, language: str = DEFAULT_LANGUAGE) -> str:
    """依設定選擇 whisper.cpp 或 faster-whisper 進行轉錄。"""
    if WHISPER_CPP_URL:
        return await whisper_cpp_transcribe(wav_bytes, language)

    model = await asyncio.to_thread(_get_stream_model)
    if ASR_BACKEND == "transformers":
        return await asyncio.to_thread(_transcribe_transformers, model, wav_bytes, language)
    return await asyncio.to_thread(_transcribe_faster_whisper, model, wav_bytes, language)


def _transcribe_faster_whisper(model: Any, wav_bytes: bytes, language: str) -> str:
    """在 thread pool 中執行 faster-whisper 同步轉錄。"""
    import io

    wav_io = io.BytesIO(wav_bytes)
    transcribe_kwargs: dict[str, Any] = {
        "language": language if language != "auto" else None,
        "vad_filter": BACKEND_VAD_ENABLED,
        "condition_on_previous_text": True,
    }
    if BACKEND_VAD_ENABLED:
        transcribe_kwargs["vad_parameters"] = {
            "threshold": BACKEND_VAD_THRESHOLD,
            "min_silence_duration_ms": BACKEND_VAD_SILENCE_MS,
            "speech_pad_ms": BACKEND_VAD_SPEECH_PAD_MS,
        }
    segments, _ = model.transcribe(wav_io, **transcribe_kwargs)
    return "".join(seg.text for seg in segments)


def _transcribe_transformers(runtime: dict[str, Any], wav_bytes: bytes, language: str) -> str:
    """在 thread pool 中執行 PyTorch/Transformers Whisper 同步轉錄。"""
    import io

    import librosa
    import numpy as np
    import soundfile as sf
    import torch

    processor = runtime["processor"]
    model = runtime["model"]
    device = runtime["device"]
    dtype = runtime["dtype"]

    audio, sample_rate = sf.read(io.BytesIO(wav_bytes), dtype="float32")
    if audio.ndim > 1:
        audio = np.mean(audio, axis=1)
    if sample_rate != 16000:
        audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=16000)
        sample_rate = 16000

    inputs = processor(audio, sampling_rate=sample_rate, return_tensors="pt")
    input_features = inputs.input_features.to(device=device, dtype=dtype)

    generate_kwargs: dict[str, Any] = {}
    if language and language != "auto":
        try:
            generate_kwargs["forced_decoder_ids"] = processor.get_decoder_prompt_ids(
                language=language,
                task="transcribe",
            )
        except Exception:
            logger.warning("Unsupported transformers language hint: %s", language)

    with torch.inference_mode():
        predicted_ids = model.generate(input_features, **generate_kwargs)
    return processor.batch_decode(predicted_ids, skip_special_tokens=True)[0].strip()
