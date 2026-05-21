from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Literal

import torch
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from transformers import AutoModel, AutoTokenizer, GenerationConfig

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

MODEL_ID = os.getenv("MODEL_ID", "MediaTek-Research/Llama-Breeze2-8B-Instruct")
MODEL_PATH = os.getenv("MODEL_PATH", "").strip() or MODEL_ID
HF_TOKEN = os.getenv("HF_TOKEN", "").strip() or None
IMG_CONTEXT_TOKEN_ID = int(os.getenv("IMG_CONTEXT_TOKEN_ID", "128212"))
DEFAULT_MAX_NEW_TOKENS = int(os.getenv("DEFAULT_MAX_NEW_TOKENS", "2048"))
DEFAULT_TEMPERATURE = float(os.getenv("DEFAULT_TEMPERATURE", "0.3"))
SYSTEM_PROMPT_FALLBACK = os.getenv(
    "SYSTEM_PROMPT_FALLBACK",
    "你是實用的繁體中文 AI 助手，使用者來自台灣。",
)

_model: Any | None = None
_tokenizer: Any | None = None
_prompt_engine: Any | None = None
_model_lock = asyncio.Lock()


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"] | str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str | None = None
    messages: list[ChatMessage]
    max_tokens: int | None = Field(default=None, ge=1)
    temperature: float | None = Field(default=None, ge=0)


def _model_device() -> torch.device:
    if _model is None:
        return torch.device("cpu")
    return next(_model.parameters()).device


def _load_model_sync() -> None:
    global _model, _tokenizer, _prompt_engine
    if _model is not None and _tokenizer is not None and _prompt_engine is not None:
        return

    from mtkresearch.llm.prompt import MRPromptV3

    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    logger.info("載入 Breeze2 模型 path=%s dtype=%s", MODEL_PATH, dtype)

    _model = AutoModel.from_pretrained(
        MODEL_PATH,
        torch_dtype=dtype,
        low_cpu_mem_usage=True,
        trust_remote_code=True,
        device_map="auto",
        token=HF_TOKEN,
        img_context_token_id=IMG_CONTEXT_TOKEN_ID,
    ).eval()
    _tokenizer = AutoTokenizer.from_pretrained(
        MODEL_PATH,
        trust_remote_code=True,
        use_fast=False,
        token=HF_TOKEN,
    )
    _prompt_engine = MRPromptV3()
    logger.info("Breeze2 模型就緒 device=%s", _model_device())


async def _ensure_model_loaded() -> None:
    if _model is not None and _tokenizer is not None and _prompt_engine is not None:
        return
    async with _model_lock:
        if _model is not None and _tokenizer is not None and _prompt_engine is not None:
            return
        await asyncio.to_thread(_load_model_sync)


def _to_breeze_conversations(messages: list[ChatMessage]) -> list[dict[str, str]]:
    conversations: list[dict[str, str]] = []
    has_system = False
    for message in messages:
        if message.role == "system":
            has_system = True
        if message.role in {"system", "user", "assistant"}:
            conversations.append({"role": message.role, "content": message.content})

    if not has_system:
        conversations.insert(0, {"role": "system", "content": SYSTEM_PROMPT_FALLBACK})
    return conversations


def _generate_sync(req: ChatCompletionRequest) -> str:
    if _model is None or _tokenizer is None or _prompt_engine is None:
        raise RuntimeError("模型尚未載入")

    conversations = _to_breeze_conversations(req.messages)
    prompt = _prompt_engine.get_prompt(conversations)
    if isinstance(prompt, tuple):
        prompt = prompt[0]

    inputs = _tokenizer(prompt, return_tensors="pt").to(_model_device())
    max_new_tokens = req.max_tokens or DEFAULT_MAX_NEW_TOKENS
    temperature = DEFAULT_TEMPERATURE if req.temperature is None else req.temperature
    generation_config = GenerationConfig(
        max_new_tokens=max_new_tokens,
        do_sample=temperature > 0,
        temperature=max(temperature, 1e-5),
        top_p=0.95,
        repetition_penalty=1.1,
        eos_token_id=128009,
    )

    with torch.inference_mode():
        output_tensors = _model.generate(**inputs, generation_config=generation_config)

    output = _tokenizer.decode(output_tensors[0], skip_special_tokens=False)
    try:
        parsed = _prompt_engine.parse_generated_str(output)
        if isinstance(parsed, dict):
            content = parsed.get("content")
            if isinstance(content, str):
                return content.strip()
    except Exception:
        logger.exception("Breeze2 輸出解析失敗，改用原始解碼結果")

    return output.replace(prompt, "", 1).strip()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await _ensure_model_loaded()
    yield


app = FastAPI(title="Breeze2 最小 OpenAI-compatible wrapper", lifespan=lifespan)


@app.get("/health")
async def health() -> JSONResponse:
    if _model is None:
        return JSONResponse({"status": "loading"}, status_code=503)
    return JSONResponse({"status": "ok", "model": MODEL_ID})


@app.post("/v1/chat/completions")
async def chat_completions(req: ChatCompletionRequest) -> JSONResponse:
    await _ensure_model_loaded()
    started = int(time.time())
    content = await asyncio.to_thread(_generate_sync, req)
    return JSONResponse(
        {
            "id": f"chatcmpl-{started}",
            "object": "chat.completion",
            "created": started,
            "model": req.model or MODEL_ID,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }
            ],
        }
    )
