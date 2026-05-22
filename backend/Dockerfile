FROM python:3.11.9-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash appuser

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ app/
COPY data/ data/

RUN mkdir -p /home/appuser/.cache/huggingface \
    && chown -R appuser:appuser /home/appuser/.cache \
    && chown -R appuser:appuser /app

USER appuser

ENV HF_HOME=/home/appuser/.cache/huggingface

# Build 時預載 Whisper 模型,部署不需要網路、冷啟動秒開
ARG STREAM_MODEL=phate334/Breeze-ASR-25-ct2
ARG HF_TOKEN
ENV STREAM_MODEL=${STREAM_MODEL} \
    HF_TOKEN=${HF_TOKEN}

RUN python - <<'PY'
import os
from huggingface_hub import snapshot_download

token = os.environ.get("HF_TOKEN") or None
snapshot_download(os.environ["STREAM_MODEL"], token=token)
PY

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
