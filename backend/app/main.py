"""FastAPI app entry。

啟動時預載 Whisper 模型；不再有 vector_store / RAG 相關初始化。
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import CORS_ORIGINS
from app.routes import _get_stream_model, router

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """啟動時預載 Whisper 模型。"""
    logger.info("預載 Whisper 模型...")
    _get_stream_model()
    logger.info("Whisper 模型就緒")
    yield


app = FastAPI(title="letsMeet — 即時會議提問助手（乙方視角）", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
