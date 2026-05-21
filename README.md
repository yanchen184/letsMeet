# letsMeet — 即時會議追問助手（乙方視角）

開會的時候按下「開始錄音」，麥克風收的甲方發言即時轉成逐字稿；
甲方問「有沒有什麼問題」的時候按「生成可問的問題」，
AI 從乙方／承接方視角回 3-5 條你應該追問的問題。

## 系統組成

```
┌──────────────┐  PCM16 WS    ┌─────────────┐  HTTP    ┌──────────┐
│ ltcfeWebDemo │ ───────────► │ api (8000)  │ ───────► │ llm 8001 │
│  (vanilla)   │ ◄─ JSON ───  │  FastAPI    │ ◄────────│ vLLM /   │
└──────────────┘              │ + Whisper   │          │  Breeze  │
       │  nginx /api 反向代理 │             │          │  wrapper │
       └──────► web (8081) ───┴─────────────┘          └──────────┘
```

- `api/`：FastAPI。`WS /api/stream` 跑 faster-whisper 即時轉錄；`POST /api/questions` 把逐字稿丟給 LLM 生成追問。
- `llm/`：vLLM / MediaTek Breeze2 wrapper，提供 OpenAI 相容 chat completions。
- `web/`：nginx 把 `ltcfeWebDemo/` 的純 HTML/JS/CSS 對外發，並反向代理 `/api/*` 到 api。
- `ltcfeWebDemo/`：純 vanilla，沒有 build step。

## 兩種使用模式

**模式 A — CLI 一次性轉檔（舊功能保留）**

```bash
python main.py /path/to/audio.mp4  # 產出 .vtt
```

`main.py` / `processor.py` 不依賴 FastAPI，本機跑 ffmpeg + faster-whisper 即可。

**模式 B — 即時會議追問（這次新加的主功能）**

需要兩件事跑起來：
1. `api/` FastAPI server（含 Whisper 模型）
2. `llm/` 一個 OpenAI 相容的 chat completions endpoint

最簡開發流程（Mac CPU，不啟動 LLM container，外接已有 LLM）：

```bash
# 1. 起 api
cd /Users/yanchen/workspace/letsMeet
source .venv/bin/activate
cd api
pip install -r requirements.txt
LLM_BASE_URL=http://your-llm-host:8001/v1 \
LLM_MODEL=MediaTek-Research/Llama-Breeze2-8B-Instruct \
DEVICE=cpu COMPUTE_TYPE=int8 \
uvicorn app.main:app --host 0.0.0.0 --port 8000

# 2. 起 web(任一靜態 server 都行)
cd /Users/yanchen/workspace/letsMeet/ltcfeWebDemo
python -m http.server 8081
# 開 http://localhost:8081
# (此模式下前端會走 http://localhost:8000，不經過 nginx 代理)
```

## Docker Compose

`docker-compose.yml` 預設：
- `DEVICE=cpu` / `COMPUTE_TYPE=int8` — Mac / 無 GPU 機可直接 build
- `llm` service 走 `Dockerfile.breeze2-wrapper`，**必須有 NVIDIA GPU**（純 CPU 跑 8B 模型實務上不可用）

完整三件套（有 GPU 機器才推薦）：

```bash
cd /Users/yanchen/workspace/letsMeet
HF_TOKEN=hf_xxx docker compose build
docker compose up -d
# web → http://localhost:8081
# api 健康檢查 → http://localhost:8000/api/health
```

只跑 api + web，把 LLM 指到外部服務：

```bash
LLM_BASE_URL=http://your-llm-host:8001/v1 \
docker compose up -d api web
```

## API 規格

### `POST /api/questions`

```json
{
  "transcript": "甲方累積的逐字稿(單一字串)",
  "prior_summary": "(可選) 上次回傳的 summary,讓伺服器跳過摘要"
}
```

回應：

```json
{
  "questions": [
    {"q": "驗收標準是？", "why": "對方未說明"},
    {"q": "誰能拍板？",   "why": "對方說『回去問』"}
  ],
  "summary": "(可選) 滑動視窗摘要,前端要 cache 之後回傳",
  "truncated": false
}
```

錯誤分流：
- `422` — `transcript` 為空
- `502` — LLM 回非 JSON / HTTP 錯誤
- `504` — LLM 超時

每個 response header 都帶 `X-Request-Id`。

### `WS /api/stream`

PCM16 LE / 16kHz / mono，前端透過 AudioWorklet 30ms/包送上來。

伺服器回 `connected` / `processing` / `transcription` / `error`。

## 設計文件

`docs/superpowers/specs/2026-05-21-letsmeet-realtime-qa-design.md`
有完整的 prompt、滑動視窗策略、為什麼砍掉 RAG 等決策紀錄。

## 測試

```bash
cd /Users/yanchen/workspace/letsMeet/api
source ../.venv/bin/activate
python -m pytest --cov=app --cov-report=term-missing -q
```

目前 ~84% 覆蓋率。`_get_stream_model`、`_transcribe_*` 等需要真 ASR 模型的路徑標 `# pragma: no cover`，屬於 integration smoke 不走 unit。

## 開發注意

- Mac CPU 環境下 Whisper 模型載入慢、轉錄速度不到 1x，正式會議建議用 GPU 機或 whisper.cpp 後端（設 `WHISPER_CPP_URL`）
- 前端目前是純 vanilla，沒有 build step；改 CSS / JS 直接 reload 瀏覽器
- 滑動視窗觸發在 6000 字（約 30-45 分鐘會議內容），會 LLM 摘要前段保留最近 4000 字原文
- LLM 輸出 JSON 容錯做了三層：strict → markdown fence strip → brace extract
