# letsMeet 即時會議提問助手 — 設計文件

- 日期: 2026-05-21
- 作者: Bob Chen
- 狀態: Approved (進入實作)

## 目的

開會時即時錄音 + 自動逐字稿，甲方講完問「有沒有問題？」時，按一鍵讓 AI 從逐字稿中以「乙方視角」生出 3-5 個該追問的問題（需求模糊、範圍未定、變更管理、時程資源、費用相關）。

不是會議紀錄工具，是**即席問答輔助**。

## 與既有專案的關係

```
~/workspace/letsMeet/        ← 本專案
├── main.py                  ← (現有) VTT 批次轉摘要 CLI，保留不動
├── processor.py             ← (現有) Gemini 摘要邏輯，保留不動
├── input/ output/ logs/     ← (現有) CLI 工具用，保留
│
├── api/                     ← (新) 從 whisper 專案搬，FastAPI + WebSocket ASR
├── ltcfeWebDemo/            ← (新) 從 whisper 專案搬，純靜態前端
├── llm/                     ← (新) 從 whisper 專案搬，Breeze-2-8B vLLM 容器
├── web/                     ← (新) 從 whisper 專案搬，Nginx 打包前端
├── docker-compose.yml       ← (新) 三服務 api/llm/web
└── docs/superpowers/specs/  ← 本文件
```

兩種模式共用同一 repo，不互相干擾：

| 模式 | 用法 |
|---|---|
| **CLI VTT 批次摘要**（現有） | `python main.py`，掃 `input/*.vtt` → `output/*.md` |
| **即時 QA 助手**（新增） | `docker-compose up`，開瀏覽器到 `http://localhost:8081/` |

## 系統架構

### 三服務拓樸

```
┌──────────────┐      ┌──────────────────────┐       ┌─────────────────┐
│ Browser      │      │  api (FastAPI)       │       │ llm (vLLM)      │
│ (麥克風)     │ ws   │  ┌──────────────┐    │ http  │ Breeze-2-8B     │
│              │─────▶│  │ /api/stream  │    │──────▶│ /v1/chat        │
│ ltcfeWebDemo │      │  │ AudioProc    │    │       │                 │
│   index.html │      │  │ faster-      │    │       │                 │
│   javascripts│      │  │  whisper     │    │       │                 │
│              │ http │  │ Breeze-ASR   │    │       │                 │
│              │─────▶│  │ /api/questions│   │       │                 │
└──────────────┘      │  └──────────────┘    │       └─────────────────┘
                      └──────────────────────┘
                              ▲
                              │ static
                      ┌──────────────┐
                      │ web (nginx)  │ ← 8081
                      └──────────────┘
```

### 元件職責

| 元件 | 來源 | 改動 |
|---|---|---|
| `ltcfeWebDemo/` | whisper fork | **重寫互動層**：保留 WebSocket 錄音邏輯，移除評鑑指標 UI，新增「生成問題」按鈕 + 卡片區 |
| `api/app/main.py` | whisper fork | 沿用（FastAPI app factory） |
| `api/app/routes.py` | whisper fork | **改寫**：刪 `/api/report`，新增 `POST /api/questions` |
| `api/app/audio_processor.py` | whisper fork | **沿用**（VAD + buffer） |
| `api/app/whisper_client.py` | whisper fork | **沿用** |
| `api/app/llm_client.py` | whisper fork | **整支改寫**：刪 RAG / few-shot / 指標查詢，改成 `generate_questions(transcript, prior_summary)` |
| `api/app/vector_store.py` | whisper fork | **刪除** |
| `api/app/data_preprocessor.py` | whisper fork | **刪除** |
| `api/data/indicators.json`, `fewshot.json` | whisper fork | **刪除** |
| `llm/` | whisper fork | **沿用** |
| `web/`, `docker-compose.yml` | whisper fork | **沿用**（compose 移除 LLM_PROMPT 相關 env） |
| `k8s/` | whisper fork | **不搬**（YAGNI） |

## 互動流程

1. 開會前打開 `http://localhost:8081/`
2. 按「開始錄音」→ 麥克風授權 → WebSocket 連 `/api/stream` → 開始送 PCM 16kHz chunks
3. 逐字稿即時 append 到畫面，前端維護完整字串
4. 甲方問「有沒有問題？」→ 按「✨ 生成可問的問題」→ `POST /api/questions { transcript, prior_summary? }`
5. 後端：若 transcript ≤ 6000 字直接送 LLM；> 6000 字啟動滑動視窗 + 摘要
6. 回傳 `{ questions: [{q, why}], summary? }`；前端 cache `summary` 供下次同會議調用
7. 卡片區渲染 3-5 個問題（含 `q` + `why`）
8. 會議結束按「停止錄音」→ 可選下載逐字稿 `.md`

## 資料流

### 即時錄音 (WebSocket)

```
mic → AudioWorklet (16kHz mono PCM int16)
    → ws.send(ArrayBuffer)
    → AudioProcessor (VAD + 緩衝 ~2-3s)
    → faster-whisper.transcribe(segment)
    → ws.send_json({type:"transcript", text, timestamp})
    → 前端 append + 滾動
```

### 生成問題 (HTTP)

```
[使用者按「生成可問的問題」]
  → POST /api/questions { transcript, prior_summary? }
  → llm_client.build_context(transcript, prior_summary)
      ├ 若 transcript ≤ 6000 字 → 直接回傳
      └ 若 > 6000 字 →
          recent = transcript[-4000:]
          older = transcript[:-4000]
          summary = prior_summary or llm.summarize(older)
          return f"【前段摘要】\n{summary}\n\n【最近原文】\n{recent}", summary
  → llm.chat(SYSTEM_PROMPT, USER_PROMPT.format(transcript=context))
  → parse_json_with_fallback(llm_response)
  → return { questions, summary }
```

## LLM Prompt 設計

### System Prompt（乙方視角追問）

```
你是一位資深的乙方專案經理，正在參與與甲方的會議。
你的任務：根據甲方剛才說的話（逐字稿），找出「現在該追問」的關鍵問題，
幫助乙方在會議當下釐清需求、降低後續執行風險。

提問原則（依優先序）：
1. 需求模糊：規格、驗收標準、定義不清的詞
2. 範圍未定：「之後再說」「再看看」「應該」這類保留語
3. 變更管理：誰能拍板、改了算誰的、流程是什麼
4. 時程與資源：里程碑、依賴方、何時給什麼
5. 費用相關：報價依據、額外費用、付款條件

輸出規範：
- 3 到 5 個問題
- 每題包含 q（要問什麼，口語化、可以直接念出來）
- 每題包含 why（為什麼該問，引用對方原話片段）
- 嚴格 JSON 格式，不要 markdown 不要前後綴
```

### 滑動視窗常數

```python
WINDOW_RECENT_CHARS = 4000     # 最近原文保留
SUMMARY_TRIGGER_CHARS = 6000   # 超此值才啟動摘要
SUMMARIZE_MAX_CHARS = 500      # 前段摘要上限
```

### Summary Prompt

```
以下是會議前半段的逐字稿，請濃縮成 500 字內的條列要點，
保留具體承諾、數字、時程、人名、模糊待釐清項目。
不要客套話，不要加任何解釋。
```

## API 規格

### `WS /api/stream`（沿用 whisper）

- Client → Server: binary PCM 16kHz mono int16 chunks
- Server → Client:
  - `{type: "connected"}`
  - `{type: "transcript", text: "...", timestamp: 12.34}`
  - `{type: "error", message: "..."}`

### `POST /api/questions`（新增）

Request:
```json
{
  "transcript": "甲方剛才說的所有話累積起來的字串",
  "prior_summary": null
}
```

Response:
```json
{
  "questions": [
    {"q": "您剛提到的『驗收標準』，目前是用哪幾個指標來判定？",
     "why": "對方說『驗收的時候我們再看』，但沒說標準"}
  ],
  "summary": null,
  "truncated": false
}
```

- `summary` 只在啟動了摘要才回（轉成 string），給前端 cache 下次帶回
- `truncated` 標示是否走過滑動視窗

## 邊界與錯誤處理

| 情境 | 處理 |
|---|---|
| transcript 為空 | 回 422，前端顯示「還沒錄到內容」 |
| LLM 回非 JSON | 嘗試 strip ```json ... ``` markdown 邊界後再 parse；失敗就 502 「LLM 輸出格式錯誤」 |
| LLM 超時 | httpx 設 30s timeout，超時回 504 |
| 麥克風授權被拒 | 前端顯示授權說明，不嘗試自動重連 |
| WebSocket 中斷 | 前端顯示「連線中斷」+ 保留累積逐字稿，使用者可重連續錄 |
| 同一逐字稿重複按生成 | 不做 debounce（手動觸發容忍度高，省複雜度） |

## 測試策略

### Unit（pytest）

- `build_context()` 三分支：短文直通、長文觸發摘要、長文 + 已有 prior_summary
- `parse_questions_json()` 容錯：純 JSON、有 markdown 邊界、半損壞 → fallback
- prompt 組裝：system / user template 變數插入正確

### Integration

- `POST /api/questions` 用 `httpx_mock` 攔 LLM upstream，端到端走過 build_context → llm → parse
- `WS /api/stream` 連線握手（不真正跑 ASR，mock _stream_model）

### Manual smoke（人工驗證）

1. `docker-compose up`（首次 build LLM image 很久，CPU 跑 8B 很慢，僅功能驗證）
2. 開瀏覽器 → 開始錄音 → 講 30 秒 → 看逐字稿
3. 按生成 → 看 3-5 題 JSON

E2E (Playwright)：**v1 不做**，純靠 unit + integration + manual smoke。

### 覆蓋率

≥80%（用 pytest --cov）。

## 部署

### v1：Mac 本機 docker-compose

```yaml
# docker-compose.yml
services:
  api:    # FastAPI, ports 8000
    environment:
      - DEVICE=cpu
      - COMPUTE_TYPE=int8
      - LLM_BASE_URL=http://llm:8001/v1
  llm:    # vLLM Breeze-2-8B, ports 8001
  web:    # nginx 靜態, ports 8081
```

### v2 以後（YAGNI 池子）

- k8s manifests
- GPU 加速
- 多會議室 session 隔離
- 帳號 / 雲端儲存逐字稿

## YAGNI 明確清單

❌ 自動偵測「對方剛問了問題」自動觸發 → 全手動按
❌ TTS 念出 AI 建議的問題 → 你自己念
❌ 多角色模式切換（記者/乙方/評審）→ 第一版固定乙方
❌ RAG / vector store / few-shot → 全砍
❌ 多人協作 / 會議室 / 帳號 → 單機單人
❌ 對話歷史持久化 → in-memory，關掉就沒
❌ k8s manifests → v2 再說
❌ E2E Playwright → v2 再說

## 風險

| 風險 | 緩解 |
|---|---|
| Mac CPU 跑 Breeze-ASR-25-ct2 太慢 | int8 量化 + 短 chunk；極端情況降到 Whisper small |
| Mac 完全跑不動 Breeze-2-8B | 接受體驗慢；備案是 `LLM_BASE_URL` 改指向 Gemini API 兼容轉接層（v2） |
| LLM JSON 輸出格式漂移 | 兩層解析：嚴格 JSON parse → strip markdown 重 parse → 失敗回 502 |
| WebSocket 在 Wi-Fi 切換時斷線 | 前端 onclose 顯示提示，使用者按「開始錄音」即可重連，不丟逐字稿 |
