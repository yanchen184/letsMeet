/* letsMeet 即時會議提問助手 - 前端主邏輯
 *
 * 設計目標：
 * - 純 vanilla JS，無 build 步驟
 * - 兩個核心功能：
 *   1. 即時錄音 → WebSocket /api/stream → 逐字稿
 *   2. POST /api/questions → 渲染問題卡片
 * - prior_summary 在前端 cache，下次同會議呼叫 /api/questions 時帶回
 */

(() => {
  "use strict";

  // ─── 設定：依當前 host 自動推導後端位置 ──────────────────────────
  // - 經 nginx (port 8081) 進來：走 same-origin /api/*
  // - 直接打開 file:// 或 dev server (e.g. live-server)：走 localhost:8000
  const SAME_ORIGIN = location.protocol === "http:" || location.protocol === "https:";
  const API_BASE = SAME_ORIGIN
    ? `${location.protocol}//${location.host}`
    : "http://localhost:8000";
  const WS_URL = (() => {
    if (SAME_ORIGIN) {
      const wsScheme = location.protocol === "https:" ? "wss" : "ws";
      return `${wsScheme}://${location.host}/api/stream`;
    }
    return "ws://localhost:8000/api/stream";
  })();

  // ─── DOM 抓取 ────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const dom = {
    btnStart: $("btnStart"),
    btnStop: $("btnStop"),
    btnAsk: $("btnAsk"),
    btnClear: $("btnClear"),
    btnDownload: $("btnDownload"),
    transcript: $("transcript"),
    questions: $("questions"),
    connState: $("connState"),
    elapsed: $("elapsed"),
    transcriptStat: $("transcriptStat"),
    questionsStat: $("questionsStat"),
    contextHint: $("contextHint"),
    meetingInfo: $("meetingInfo"),
    contextBody: $("contextBody"),
    btnContextToggle: $("btnContextToggle"),
    chkAutoAsk: $("chkAutoAsk"),
    btnAskRange: $("btnAskRange"),
    btnClearSel: $("btnClearSel"),
    digestArea: $("digestArea"),
    digestList: $("digestList"),
    chatLog: $("chatLog"),
    chatForm: $("chatForm"),
    chatInput: $("chatInput"),
    chatSend: $("chatSend"),
    chatStat: $("chatStat"),
    btnSaveMeeting: $("btnSaveMeeting"),
    btnHistory: $("btnHistory"),
  };

  const pad2 = (n) => String(n).padStart(2, "0");

  // ─── 狀態 ────────────────────────────────────────────────────────
  const state = {
    ws: null,
    audioCtx: null,
    workletUrl: null,
    mediaStream: null,
    audioSource: null,
    audioProc: null,
    isRecording: false,
    transcriptLines: [], // [{t: secondsFromStart, text}]
    priorSummary: null,  // 後端回傳的「前段摘要」cache
    startEpoch: 0,
    elapsedTimer: null,
    errorTimer: null,
    clearConfirmTimer: null,
    askTimer: null,
    askStartedAt: 0,
    // ── 新功能狀態 ──
    questionItems: [],       // 累積問題 [{q, why, source}]，疊加不清空
    seenQuestions: new Set(),// 去重用,key = q 文字
    autoAsk: false,          // 自動產問開關
    linesSinceAutoAsk: 0,    // 距上次自動產問累積的行數
    selAnchor: null,         // 區間選取起點 index;null = 未選
    selFocus: null,          // 區間選取終點 index
    askedThrough: 0,         // 游標:已產問涵蓋到「第幾行之前」(exclusive)。新行 = transcriptLines.slice(askedThrough)
    audioChunks: [],         // 錄音 PCM 累積 [Int16Array, ...]，停止時拼成 WAV
    audioSamples: 0,         // 已累積 sample 數，用來算時長與配置 buffer
    digests: [],             // 重點摘要 [{from, to, summary}]，每次產問順手 append
    chatHistory: [],         // chat 對話 [{role, content}]，只存記憶體
    chatStreaming: false,    // chat 串流進行中，避免重複送出
  };

  const RECORD_SAMPLE_RATE = 16000; // 與 AudioWorklet targetSampleRate 一致
  const MIN_LINES_TO_ASK = 3;
  const AUTO_ASK_EVERY_LINES = 8; // 每累積這麼多行,自動產問一次

  // 四種溝通情境的背景範本;點按鈕覆蓋填入 contextHint
  const CONTEXT_PRESETS = {
    client:
      "我是乙方專案經理，正在跟甲方／客戶開會。請站在我的立場，幫我追問釐清需求、" +
      "驗收標準、範圍邊界、變更誰拍板、時程與費用，把對方含糊或保留的說法挖清楚。",
    engineer:
      "我是 PM／需求方，正在跟工程師討論實作。請幫我追問技術可行性、工時估算依據、" +
      "技術依賴與卡點、潛在風險、以及「做不完時砍什麼」的取捨，避免工程師低估或漏講風險。",
    pm:
      "我是工程師，正在跟 PM／產品方對需求。請幫我追問規格細節、需求優先序、" +
      "驗收條件、deadline 是否合理、誰能拍板改規格，把模糊的需求變成可實作的明確條件。",
    eng_pm:
      "這是工程師與 PM 的協調會議，我要居中釐清雙方落差。請幫我追問：規格認知是否一致、" +
      "估時與期程有沒有衝突、技術債與功能取捨怎麼決定、變更與責任歸屬，讓兩邊對齊。",
  };

  // ─── AudioWorklet：把麥克風 PCM resample 成 16kHz int16 ──────────
  const WORKLET_CODE = `
class PCM16Writer extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = (o && o.processorOptions) || {};
    this.targetRate = p.targetSampleRate || 16000;
    this.frameMs = p.frameDurationMs || 30;
    this.srcRate = sampleRate;
    this.ratio = this.srcRate / this.targetRate;
    this.accum = [];
    this.samplesPerFrame = Math.round(this.targetRate * (this.frameMs / 1000));
    this.port.onmessage = (ev) => {
      if (ev.data && ev.data.type === 'flush') this.flush();
    };
  }
  ds(ch) {
    const n = Math.floor(ch.length / this.ratio);
    const out = new Float32Array(n);
    let i = 0, pos = 0;
    while (i < n) {
      const idx = pos | 0, fr = pos - idx;
      const s0 = ch[idx] || 0, s1 = ch[idx + 1] || s0;
      out[i++] = s0 + (s1 - s0) * fr;
      pos += this.ratio;
    }
    return out;
  }
  toI16(f) {
    const b = new ArrayBuffer(f.length * 2);
    const dv = new DataView(b);
    for (let i = 0; i < f.length; i++) {
      let s = Math.max(-1, Math.min(1, f[i]));
      dv.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return b;
  }
  emit() {
    while (this.accum.length >= this.samplesPerFrame) {
      const frame = this.accum.splice(0, this.samplesPerFrame);
      const b = this.toI16(Float32Array.from(frame));
      this.port.postMessage(b, [b]);
    }
  }
  flush() {
    if (!this.accum.length) return;
    const pad = new Float32Array(this.samplesPerFrame);
    pad.set(Float32Array.from(this.accum));
    const b = this.toI16(pad);
    this.port.postMessage(b, [b]);
    this.accum = [];
  }
  process(inputs) {
    const ch = (inputs[0] || [])[0];
    if (!ch) return true;
    const ds = this.ds(ch);
    for (let i = 0; i < ds.length; i++) this.accum.push(ds[i]);
    this.emit();
    return true;
  }
}
registerProcessor('pcm16-writer', PCM16Writer);
`;

  async function ensureWorkletReady() {
    if (!state.audioCtx) {
      state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (!state.workletUrl) {
      const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
      state.workletUrl = URL.createObjectURL(blob);
      await state.audioCtx.audioWorklet.addModule(state.workletUrl);
    }
    return state.audioCtx;
  }

  // ─── UI 控制 ─────────────────────────────────────────────────────
  function setConn(kind, label) {
    dom.connState.className = `badge ${kind}`;
    dom.connState.textContent = label;
  }

  // showError(msg, { persistent }) — persistent=true 不自動消,要使用者按 ✕
  function showError(msg, { persistent = false } = {}) {
    let banner = document.querySelector(".error-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "error-banner";
      banner.setAttribute("role", "alert");
      banner.setAttribute("aria-live", "assertive");
      banner.innerHTML = `<span class="error-text"></span>` +
        `<button class="error-close" type="button" aria-label="關閉錯誤訊息">×</button>`;
      banner.querySelector(".error-close")
        .addEventListener("click", () => banner.remove());
      document.querySelector("main").prepend(banner);
    }
    banner.querySelector(".error-text").textContent = msg;
    if (state.errorTimer) clearTimeout(state.errorTimer);
    if (!persistent) {
      state.errorTimer = setTimeout(() => banner.remove(), 6000);
    }
  }

  function fmtElapsed(secs) {
    const m = String(Math.floor(secs / 60)).padStart(2, "0");
    const s = String(secs % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  function fmtElapsedLong(secs) {
    const h = String(Math.floor(secs / 3600)).padStart(2, "0");
    const m = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
    const s = String(secs % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  function startElapsed() {
    state.startEpoch = Date.now();
    state.elapsedTimer = setInterval(() => {
      const e = Math.floor((Date.now() - state.startEpoch) / 1000);
      dom.elapsed.textContent = fmtElapsedLong(e);
    }, 1000);
  }

  function stopElapsed() {
    if (state.elapsedTimer) {
      clearInterval(state.elapsedTimer);
      state.elapsedTimer = null;
    }
  }

  function updateTranscriptStat() {
    if (!dom.transcriptStat) return;
    const n = state.transcriptLines.length;
    dom.transcriptStat.textContent = n === 0 ? "—" : `${n} 行`;
  }

  function updateQuestionsStat(count) {
    if (!dom.questionsStat) return;
    dom.questionsStat.textContent = count === 0 ? "—" : `${count} 題`;
  }

  function appendTranscriptLine(text) {
    if (!text || !text.trim()) return;
    if (state.transcriptLines.length === 0) {
      dom.transcript.innerHTML = "";
    }
    const t = Math.floor((Date.now() - state.startEpoch) / 1000);
    const idx = state.transcriptLines.length;
    state.transcriptLines.push({ t, text: text.trim() });
    const p = document.createElement("p");
    p.className = "line";
    p.dataset.index = String(idx);
    p.setAttribute("role", "button");
    p.setAttribute("tabindex", "0");
    p.title = "點選以選取區間（點兩行框出範圍）";
    p.innerHTML =
      `<span class="ts">${fmtElapsed(t)}</span>` +
      `<span class="x"></span>`;
    p.querySelector(".x").textContent = text.trim();
    dom.transcript.appendChild(p);
    dom.transcript.scrollTop = dom.transcript.scrollHeight;

    updateTranscriptStat();
    refreshAskButton();

    // 自動產問:每累積 AUTO_ASK_EVERY_LINES 行觸發一次
    if (state.autoAsk) {
      state.linesSinceAutoAsk += 1;
      if (
        state.linesSinceAutoAsk >= AUTO_ASK_EVERY_LINES &&
        state.transcriptLines.length >= MIN_LINES_TO_ASK &&
        !state.askTimer
      ) {
        state.linesSinceAutoAsk = 0;
        askQuestions({ source: "auto" });
      }
    }
  }

  // ─── 區間選取 ────────────────────────────────────────────────────
  function selectionRange() {
    if (state.selAnchor === null) return null;
    const a = state.selAnchor;
    const b = state.selFocus === null ? a : state.selFocus;
    return { lo: Math.min(a, b), hi: Math.max(a, b) };
  }

  function renderSelectionHighlight() {
    const range = selectionRange();
    dom.transcript.querySelectorAll(".line").forEach((el) => {
      const i = Number(el.dataset.index);
      const on = range && i >= range.lo && i <= range.hi;
      el.classList.toggle("selected", !!on);
    });
    const hasSel = !!range;
    if (dom.btnAskRange) dom.btnAskRange.hidden = !hasSel || state.transcriptLines.length === 0;
    if (dom.btnClearSel) dom.btnClearSel.hidden = !hasSel;
    if (dom.btnAskRange && hasSel) {
      const n = range.hi - range.lo + 1;
      dom.btnAskRange.textContent = `問選取區間（${n} 行）`;
      dom.btnAskRange.disabled = !!state.askTimer;
    }
  }

  function handleLineClick(idx) {
    if (state.selAnchor === null || state.selFocus !== null) {
      // 開新選取
      state.selAnchor = idx;
      state.selFocus = null;
    } else {
      // 已有起點,這次點是終點
      state.selFocus = idx;
    }
    renderSelectionHighlight();
  }

  function clearSelection() {
    state.selAnchor = null;
    state.selFocus = null;
    renderSelectionHighlight();
  }

  function refreshAskButton() {
    if (!dom.btnAsk) return;
    const enoughLines = state.transcriptLines.length >= MIN_LINES_TO_ASK;
    dom.btnAsk.disabled = !enoughLines || !!state.askTimer;
    dom.btnAsk.title = enoughLines
      ? "由 AI 從目前逐字稿產出 3–5 個追問"
      : `逐字稿至少要 ${MIN_LINES_TO_ASK} 行才能產出有意義的問題`;
    refreshSaveMeetingButton();
  }

  function resetClearConfirm() {
    if (state.clearConfirmTimer) {
      clearTimeout(state.clearConfirmTimer);
      state.clearConfirmTimer = null;
    }
    dom.btnClear.classList.remove("confirm");
    dom.btnClear.textContent = "清空";
  }

  function doClearTranscript() {
    state.transcriptLines = [];
    state.priorSummary = null;
    state.questionItems = [];
    state.seenQuestions.clear();
    state.linesSinceAutoAsk = 0;
    state.askedThrough = 0;
    state.audioChunks = [];
    state.audioSamples = 0;
    state.digests = [];
    state.chatHistory = [];
    clearSelection();
    dom.transcript.innerHTML =
      '<p class="placeholder">按「錄音」開始即時轉錄。會請求麥克風權限,音訊僅在本機處理。</p>';
    dom.questions.innerHTML =
      '<p class="placeholder">按「產生問題」由 AI 從逐字稿產出 3–5 個追問。</p>';
    renderDigests();
    renderChatLog();
    updateTranscriptStat();
    updateQuestionsStat(0);
    refreshAskButton();
  }

  // 二段式:第一次點 → 改文字提示再點一次,3 秒未確認自動取消
  function handleClearClick() {
    if (state.isRecording) return; // 錄音中本來就 disabled,雙保險
    if (state.transcriptLines.length === 0) {
      // 沒東西可清,直接重置畫面(不需確認)
      doClearTranscript();
      return;
    }
    if (!dom.btnClear.classList.contains("confirm")) {
      dom.btnClear.classList.add("confirm");
      dom.btnClear.textContent = "再點一次確認清空";
      state.clearConfirmTimer = setTimeout(resetClearConfirm, 3000);
      return;
    }
    resetClearConfirm();
    doClearTranscript();
  }

  function getFullTranscript() {
    return state.transcriptLines.map((l) => l.text).join(" ");
  }

  // 游標之後的「新行」原文(上次產問後新增的內容)
  function getRecentTranscript() {
    return state.transcriptLines
      .slice(state.askedThrough)
      .map((l) => l.text)
      .join(" ");
  }

  const SOURCE_LABEL = {
    manual: "手動",
    auto: "自動",
    range: "區間",
  };

  // 把新一批問題去重後疊加到 state.questionItems;回傳實際新增數
  function addQuestions(questions, source) {
    if (!questions || questions.length === 0) return 0;
    let added = 0;
    questions.forEach((q) => {
      const key = (q.q || "").trim();
      if (!key || state.seenQuestions.has(key)) return;
      state.seenQuestions.add(key);
      state.questionItems.push({ q: key, why: (q.why || "").trim(), source });
      added += 1;
    });
    if (added > 0) renderQuestionsList();
    return added;
  }

  function removeQuestion(idx) {
    const item = state.questionItems[idx];
    if (!item) return;
    state.seenQuestions.delete(item.q);
    state.questionItems.splice(idx, 1);
    renderQuestionsList();
  }

  function renderQuestionsList() {
    dom.questions.innerHTML = "";
    if (state.questionItems.length === 0) {
      dom.questions.innerHTML =
        '<p class="placeholder">按「產生問題」由 AI 從逐字稿產出 3–5 個追問。</p>';
      updateQuestionsStat(0);
      return;
    }
    state.questionItems.forEach((q, i) => {
      const card = document.createElement("article");
      card.className = "question-card";

      const num = document.createElement("span");
      num.className = "q-num";
      num.textContent = pad2(i + 1);

      const body = document.createElement("div");
      body.className = "q-body";

      const qtext = document.createElement("h3");
      qtext.className = "q-text";
      qtext.textContent = q.q;
      body.appendChild(qtext);

      if (q.why) {
        const why = document.createElement("p");
        why.className = "q-why";
        why.textContent = q.why;
        body.appendChild(why);
      }

      const tag = document.createElement("span");
      tag.className = `q-source q-source-${q.source}`;
      tag.textContent = SOURCE_LABEL[q.source] || q.source;
      body.appendChild(tag);

      const del = document.createElement("button");
      del.className = "q-del";
      del.type = "button";
      del.setAttribute("aria-label", "刪除這個問題");
      del.title = "刪除";
      del.textContent = "×";
      del.addEventListener("click", () => removeQuestion(i));

      card.appendChild(num);
      card.appendChild(body);
      card.appendChild(del);
      dom.questions.appendChild(card);
    });
    updateQuestionsStat(state.questionItems.length);
    refreshSaveMeetingButton();
  }

  // ─── 重點摘要 ────────────────────────────────────────────────────
  function renderDigests() {
    if (!dom.digestArea || !dom.digestList) return;
    if (state.digests.length === 0) {
      dom.digestArea.hidden = true;
      dom.digestList.innerHTML = "";
      return;
    }
    dom.digestArea.hidden = false;
    dom.digestList.innerHTML = "";
    state.digests.forEach((d, i) => {
      const block = document.createElement("div");
      block.className = "digest-block";

      const meta = document.createElement("div");
      meta.className = "digest-meta";
      meta.textContent = `第 ${i + 1} 段（第 ${d.from + 1}–${d.to} 行）`;
      block.appendChild(meta);

      const body = document.createElement("div");
      body.className = "digest-text";
      if (d.summary) {
        body.textContent = d.summary;
      } else {
        body.className = "digest-text digest-failed";
        body.textContent = "（這段摘要產生失敗）";
      }
      block.appendChild(body);
      dom.digestList.appendChild(block);
    });
  }

  // 把指定行區間 [from, to) 的逐字稿壓成重點，append 進 state.digests。
  // 失敗不擋主流程，存 summary=null 由 render 顯示佔位。
  async function appendDigest(from, to) {
    if (to <= from) return;
    const text = state.transcriptLines
      .slice(from, to)
      .map((l) => l.text)
      .join(" ");
    if (!text.trim()) return;
    const entry = { from, to, summary: null };
    state.digests.push(entry);
    renderDigests();
    try {
      const resp = await fetch(`${API_BASE}/api/digest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: text }),
      });
      if (resp.ok) {
        const data = await resp.json();
        entry.summary = data.summary || "";
      }
    } catch (err) {
      console.error("digest failed", err);
    } finally {
      renderDigests();
    }
  }

  // ─── Chat（SSE streaming）────────────────────────────────────────
  function updateChatStat() {
    if (!dom.chatStat) return;
    const n = state.chatHistory.length;
    dom.chatStat.textContent = n === 0 ? "—" : `${n} 則`;
  }

  // 重畫整個對話；streamingEl 為 true 時最後一則 assistant 標成串流中
  function renderChatLog() {
    if (!dom.chatLog) return;
    if (state.chatHistory.length === 0) {
      dom.chatLog.innerHTML =
        '<p class="placeholder">隨時問 AI 剛剛逐字稿講了什麼，或一起討論接下來該怎麼問。</p>';
      updateChatStat();
      return;
    }
    dom.chatLog.innerHTML = "";
    state.chatHistory.forEach((m) => {
      const bubble = document.createElement("div");
      bubble.className = `chat-msg chat-${m.role}`;
      bubble.textContent = m.content;
      dom.chatLog.appendChild(bubble);
    });
    dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
    updateChatStat();
  }

  async function sendChat() {
    if (state.chatStreaming) return;
    const text = (dom.chatInput.value || "").trim();
    if (!text) return;

    state.chatHistory.push({ role: "user", content: text });
    const assistantMsg = { role: "assistant", content: "" };
    state.chatHistory.push(assistantMsg);
    dom.chatInput.value = "";
    state.chatStreaming = true;
    dom.chatSend.disabled = true;
    renderChatLog();

    // 帶到後端的對話歷史(不含剛 push 的空 assistant 佔位)
    const history = state.chatHistory
      .slice(0, -1)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const resp = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history,
          transcript: getFullTranscript(),
          context: buildContext(),
          asked_questions: state.questionItems.map((it) => it.q),
        }),
      });
      if (!resp.ok || !resp.body) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamError = null;

      // SSE：以 \n\n 分隔事件，每事件一行 data:
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop(); // 最後一段可能不完整，留著
        for (const ev of events) {
          const line = ev.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload);
            if (obj.error) {
              streamError = obj.error;
            } else if (obj.delta) {
              assistantMsg.content += obj.delta;
              renderChatLog();
            }
          } catch (_) {
            /* 忽略半截 JSON */
          }
        }
      }

      if (streamError) {
        assistantMsg.content = assistantMsg.content || `（${streamError}）`;
        renderChatLog();
      } else if (!assistantMsg.content) {
        assistantMsg.content = "（AI 沒有回覆內容）";
        renderChatLog();
      }
    } catch (err) {
      console.error(err);
      assistantMsg.content = `（對話失敗：${err.message || err}）`;
      renderChatLog();
    } finally {
      state.chatStreaming = false;
      dom.chatSend.disabled = false;
      dom.chatInput.focus();
    }
  }

  // ─── WebSocket / 錄音 ────────────────────────────────────────────
  async function startRecording() {
    if (state.isRecording) return;
    setConn("connecting", "連線中");
    dom.btnStart.disabled = true;
    document.body.classList.add("is-recording");

    try {
      const ctx = await ensureWorkletReady();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      state.ws = new WebSocket(WS_URL);
      state.ws.binaryType = "arraybuffer";

      state.ws.onopen = () => {
        setConn("recording", "錄音中");
      };
      state.ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === "transcription" && data.text) {
            appendTranscriptLine(data.text);
          } else if (data.type === "error") {
            showError(data.message || "後端錯誤");
          }
        } catch (_) {
          /* ignore non-JSON frames */
        }
      };
      state.ws.onerror = () => {
        showError("WebSocket 錯誤,請檢查後端服務是否啟動", { persistent: true });
      };
      state.ws.onclose = () => {
        if (state.isRecording) {
          showError("連線中斷,目前的逐字稿已保留;按「錄音」可重新連線續錄", { persistent: true });
          stopRecording({ keepTranscript: true });
        }
      };

      const source = ctx.createMediaStreamSource(stream);
      const processor = new AudioWorkletNode(ctx, "pcm16-writer", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        processorOptions: { targetSampleRate: 16000, frameDurationMs: 30 },
      });
      processor.port.onmessage = (ev) => {
        // 累積 PCM 供停止時匯出 WAV(複本,避免與 ws.send 共用同一 buffer 出意外)
        const pcm = new Int16Array(ev.data.slice(0));
        state.audioChunks.push(pcm);
        state.audioSamples += pcm.length;
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(ev.data);
        }
      };
      source.connect(processor);

      state.mediaStream = stream;
      state.audioSource = source;
      state.audioProc = processor;
      state.isRecording = true;

      dom.btnStop.disabled = false;
      dom.btnStart.disabled = true;
      dom.btnStart.textContent = "錄音中";
      dom.btnClear.disabled = true;
      resetClearConfirm();
      if (state.transcriptLines.length === 0) {
        // 全新一段:清空上一場的音訊累積(續錄則接著累積)
        state.audioChunks = [];
        state.audioSamples = 0;
        startElapsed();
      }
    } catch (err) {
      console.error(err);
      const msg = (err && err.name === "NotAllowedError")
        ? "麥克風權限被拒,請到瀏覽器網址列左側的鎖頭圖示重新允許"
        : `無法啟動錄音:${err.message || err}`;
      showError(msg, { persistent: true });
      setConn("offline", "待機");

      document.body.classList.remove("is-recording");
      dom.btnStart.disabled = false;
      dom.btnStart.textContent = "錄音";
      dom.btnClear.disabled = false;
    }
  }

  function stopRecording({ keepTranscript = true, exportAudio = false } = {}) {
    state.isRecording = false;
    try { state.audioSource?.disconnect(); } catch (_) {}
    try {
      // flush 會讓 worklet 補送最後一包(非同步回到 onmessage),稍後再打包 WAV
      state.audioProc?.port.postMessage({ type: "flush" });
    } catch (_) {}
    // 使用者主動停止 → 等 flush 的最後一包進來後匯出整場 WAV
    if (exportAudio && state.audioSamples > 0) {
      const proc = state.audioProc;
      const chunksRef = state.audioChunks; // 抓 reference,避免後續清空影響匯出
      setTimeout(() => {
        try { proc?.disconnect(); } catch (_) {}
        if (chunksRef.length) {
          const blob = buildWavBlob(chunksRef, RECORD_SAMPLE_RATE);
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = buildMeetingFilename("wav");
          a.click();
          URL.revokeObjectURL(url);
        }
      }, 150);
    } else {
      try { state.audioProc?.disconnect(); } catch (_) {}
    }
    try { state.mediaStream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { state.ws?.close(); } catch (_) {}
    state.ws = null;
    state.mediaStream = null;
    state.audioSource = null;
    state.audioProc = null;

    stopElapsed();
    setConn("offline", "待機");

    document.body.classList.remove("is-recording");
    dom.btnStart.disabled = false;
    dom.btnStart.textContent = "錄音";
    dom.btnStop.disabled = true;
    dom.btnClear.disabled = false;
    refreshAskButton();

    if (!keepTranscript) doClearTranscript();
  }

  // ─── 生成問題 ────────────────────────────────────────────────────
  const ASK_LABEL = { manual: "產生問題", auto: "自動產問", range: "問選取區間" };

  function startAskTimer(source) {
    state.askStartedAt = Date.now();
    const base = source === "auto" ? "自動產問中" : "思考中";
    const tick = () => {
      const e = Math.floor((Date.now() - state.askStartedAt) / 1000);
      dom.btnAsk.textContent = `${base} ${fmtElapsed(e)}`;
      if (dom.questionsStat) dom.questionsStat.textContent = `${base} ${fmtElapsed(e)}`;
    };
    tick();
    state.askTimer = setInterval(tick, 1000);
  }

  function stopAskTimer() {
    if (state.askTimer) {
      clearInterval(state.askTimer);
      state.askTimer = null;
    }
    dom.btnAsk.textContent = "產生問題";
  }

  // 取選取區間的逐字稿文字;無選取回 null
  function getRangeTranscript() {
    const range = selectionRange();
    if (!range) return null;
    return state.transcriptLines
      .slice(range.lo, range.hi + 1)
      .map((l) => l.text)
      .join(" ");
  }

  // source: "manual" | "auto" | "range"
  //
  // 游標式增量產問：
  //   - range  → 只送選取區間,獨立分析,不帶/不動游標與 cache
  //   - auto   → 只送「游標後的新行」,舊內容走 prior_summary/older_transcript 當背景;
  //              新行太少就跳過(別為 1-2 行硬產)
  //   - manual → 同 auto 走增量;但若沒有新行,退回全文重問(使用者明確要)
  // 把「我的角色與重點」+「會議資訊」兩欄合併成一段帶標籤的脈絡送給後端。
  // 兩欄都空 → 回 null(後端 context 可選)。
  function buildContext() {
    const role = (dom.contextHint?.value || "").trim();
    const info = (dom.meetingInfo?.value || "").trim();
    const parts = [];
    if (role) parts.push(`【我的角色與重點】\n${role}`);
    if (info) parts.push(`【會議資訊】\n${info}`);
    return parts.length ? parts.join("\n\n") : null;
  }

  async function askQuestions({ source = "manual" } = {}) {
    if (state.askTimer) return; // 已在跑,別重複觸發

    const isRange = source === "range";
    const totalLines = state.transcriptLines.length;
    const newLineCount = totalLines - state.askedThrough;

    // 決定這次要送什麼
    let transcript;
    let olderTranscript = null;
    let priorSummary = null;
    let advanceCursor = false; // 成功後是否推進游標
    if (isRange) {
      transcript = getRangeTranscript();
    } else if (newLineCount > 0) {
      // 增量:只送新行,舊內容當背景
      transcript = getRecentTranscript();
      priorSummary = state.priorSummary;
      // 還沒摘要過(cache 空)且游標前有舊行 → 把舊原文丟給後端摘要
      if (!priorSummary && state.askedThrough > 0) {
        olderTranscript = state.transcriptLines
          .slice(0, state.askedThrough)
          .map((l) => l.text)
          .join(" ");
      }
      advanceCursor = true;
    } else {
      // 沒有新行
      if (source === "auto") return;        // 自動:沒新內容就不產
      transcript = getFullTranscript();      // 手動:退回全文重問
    }

    if (!transcript || !transcript.trim()) {
      if (source !== "auto") showError("還沒有逐字稿可以分析");
      return;
    }
    // 行數門檻:看「整份」夠不夠(增量只送新行,但整場已累積足量就算數)
    if (!isRange && totalLines < MIN_LINES_TO_ASK) {
      if (source !== "auto") {
        showError(`逐字稿至少要 ${MIN_LINES_TO_ASK} 行才能產出有意義的問題`);
      }
      return;
    }

    // 鎖住這次產問涵蓋到的行,避免送出後又有新行進來導致游標錯位
    const cursorTarget = totalLines;

    startAskTimer(source);
    refreshAskButton();
    renderSelectionHighlight();

    try {
      const resp = await fetch(`${API_BASE}/api/questions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          prior_summary: priorSummary,
          older_transcript: olderTranscript,
          context: buildContext(),
          asked_questions: state.questionItems.map((it) => it.q),
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      if (!isRange) {
        if (data.summary) state.priorSummary = data.summary;
        if (advanceCursor) {
          const digestFrom = state.askedThrough;
          state.askedThrough = cursorTarget;
          state.linesSinceAutoAsk = 0; // 產過問就重置,避免手動產完馬上被自動觸發
          // 順手把本批新發言壓成重點摘要(不 await,不擋產問回應)
          appendDigest(digestFrom, cursorTarget);
        }
      }
      const added = addQuestions(data.questions, source);
      if (added === 0 && state.questionItems.length > 0) {
        // 全是重複題,給個輕提示但不洗掉既有列表
        showError("這批問題與既有的重複,未新增");
      } else if (state.questionItems.length === 0) {
        dom.questions.innerHTML =
          '<p class="placeholder">這次沒有產出問題,逐字稿可能太短了。</p>';
        updateQuestionsStat(0);
      }
    } catch (err) {
      console.error(err);
      showError(`生成問題失敗:${err.message || err}`);
      // 疊加模型:失敗不洗掉既有問題,只在空列表時提示
      if (state.questionItems.length === 0) {
        dom.questions.innerHTML = '<p class="placeholder">生成失敗,請重試。</p>';
        updateQuestionsStat(0);
      }
    } finally {
      stopAskTimer();
      refreshAskButton();
      renderSelectionHighlight();
    }
  }

  // ─── 下載逐字稿 ──────────────────────────────────────────────────
  function downloadTranscript() {
    if (state.transcriptLines.length === 0) {
      showError("沒有可下載的內容");
      return;
    }
    const md = [
      `# 會議逐字稿`,
      ``,
      `產生時間：${new Date().toLocaleString()}`,
      ``,
      ...state.transcriptLines.map((l) => `- [${fmtElapsed(l.t)}] ${l.text}`),
      ``,
    ].join("\n");
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = buildMeetingFilename();
    a.click();
    URL.revokeObjectURL(url);
  }

  function buildMeetingFilename(ext = "md") {
    const d = new Date();
    const y = d.getFullYear();
    const mo = pad2(d.getMonth() + 1);
    const da = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const mm = pad2(d.getMinutes());
    return `meeting_${y}-${mo}-${da}_${hh}${mm}.${ext}`;
  }

  // 把累積的 16-bit PCM(mono)包成標準 WAV blob
  function buildWavBlob(chunks, sampleRate) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const dataBytes = total * 2;
    const buf = new ArrayBuffer(44 + dataBytes);
    const dv = new DataView(buf);
    const wstr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    wstr(0, "RIFF");
    dv.setUint32(4, 36 + dataBytes, true);
    wstr(8, "WAVE");
    wstr(12, "fmt ");
    dv.setUint32(16, 16, true);       // PCM fmt chunk size
    dv.setUint16(20, 1, true);        // audio format = PCM
    dv.setUint16(22, 1, true);        // channels = mono
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * 2, true); // byte rate = rate * channels * bytesPerSample
    dv.setUint16(32, 2, true);        // block align = channels * bytesPerSample
    dv.setUint16(34, 16, true);       // bits per sample
    wstr(36, "data");
    dv.setUint32(40, dataBytes, true);
    let off = 44;
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++) { dv.setInt16(off, c[i], true); off += 2; }
    }
    return new Blob([buf], { type: "audio/wav" });
  }


  // ─── 存成會議記錄（Task 8）─────────────────────────────────────
  const LS_OWNER_KEY = "letsmeet_owner";

  function refreshSaveMeetingButton() {
    if (!dom.btnSaveMeeting) return;
    const hasContent = state.transcriptLines.length > 0 || state.questionItems.length > 0;
    dom.btnSaveMeeting.disabled = !hasContent;
  }

  function showSaveForm() {
    const formEl = $("saveMeetingForm");
    if (!formEl) return;
    // 預填 owner from localStorage
    const ownerInput = $("saveMeetingOwner");
    if (ownerInput && !ownerInput.value) {
      ownerInput.value = localStorage.getItem(LS_OWNER_KEY) || "";
    }
    // 清除舊訊息
    const msgEl = $("saveMeetingMsg");
    if (msgEl) { msgEl.hidden = true; msgEl.textContent = ""; }
    formEl.hidden = false;
    const titleInput = $("saveMeetingTitle");
    if (titleInput) titleInput.focus();
  }

  function hideSaveForm() {
    const formEl = $("saveMeetingForm");
    if (formEl) formEl.hidden = true;
  }

  function setSaveMsg(text, isError) {
    const msgEl = $("saveMeetingMsg");
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.className = "save-meeting-form__msg" + (isError ? " save-meeting-form__msg--error" : " save-meeting-form__msg--ok");
    msgEl.hidden = false;
  }

  async function doSaveMeeting() {
    const titleInput = $("saveMeetingTitle");
    const ownerInput = $("saveMeetingOwner");
    const title = (titleInput?.value || "").trim();
    const owner = (ownerInput?.value || "").trim();

    if (!title || !owner) {
      setSaveMsg("標題與填寫者必填", true);
      return;
    }

    const confirmBtn = $("btnSaveMeetingConfirm");
    if (confirmBtn) confirmBtn.disabled = true;

    try {
      const questions = state.questionItems.map((it) => ({ q: it.q, why: it.why }));
      const summary = state.digests.map((d) => d.summary).filter(Boolean).join("\n");
      const resp = await fetch(`${API_BASE}/api/meetings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          owner,
          context: buildContext(),
          summary: summary || null,
          transcript: getFullTranscript() || null,
          questions: questions.length ? questions : null,
        }),
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        setSaveMsg(errData.error || `儲存失敗 (HTTP ${resp.status})`, true);
        return;
      }
      // success
      localStorage.setItem(LS_OWNER_KEY, owner);
      setSaveMsg("已存檔 ✓", false);
      // 短暫停留後自動關閉表單
      setTimeout(hideSaveForm, 1500);
    } catch (err) {
      setSaveMsg(`儲存失敗:${err.message || err}`, true);
    } finally {
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  // ─── 歷史會議 Modal（Task 9）─────────────────────────────────────
  let _historyAllMeetings = []; // 最近抓到的列表(未過濾)

  function openHistoryModal() {
    const modal = $("historyModal");
    if (!modal) return;
    modal.hidden = false;
    // 每次開啟重置到列表視圖
    showHistoryListView();
    loadHistoryList();
  }

  function closeHistoryModal() {
    const modal = $("historyModal");
    if (modal) modal.hidden = true;
  }

  function showHistoryListView() {
    const modal = $("historyModal");
    if (!modal) return;
    const listView = modal.querySelector(".history-modal__listView");
    const detailView = modal.querySelector(".history-modal__detailView");
    if (listView) listView.hidden = false;
    if (detailView) detailView.hidden = true;
    // 清掉 detail 內容
    if (detailView) detailView.innerHTML = "";
    // 重置標題過濾,避免重開時輸入框殘留舊文字與未過濾列表不一致
    const filterInput = modal.querySelector(".history-filter");
    if (filterInput) filterInput.value = "";
  }

  async function loadHistoryList() {
    const modal = $("historyModal");
    if (!modal) return;
    const listEl = modal.querySelector(".history-list");
    if (!listEl) return;

    // 清空 + 顯示 loading
    listEl.innerHTML = "";
    const loadingLi = document.createElement("li");
    loadingLi.className = "history-list__loading";
    loadingLi.textContent = "載入中…";
    listEl.appendChild(loadingLi);

    try {
      const owner = localStorage.getItem(LS_OWNER_KEY) || "";
      const qs = owner ? `?owner=${encodeURIComponent(owner)}` : "";
      const resp = await fetch(`${API_BASE}/api/meetings${qs}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      _historyAllMeetings = data.meetings || [];
      renderHistoryList(_historyAllMeetings, modal);
    } catch (err) {
      listEl.innerHTML = "";
      const errLi = document.createElement("li");
      errLi.className = "history-list__error";
      const errText = document.createElement("span");
      errText.textContent = `載入失敗:${err.message || err}`;
      const retryBtn = document.createElement("button");
      retryBtn.className = "btn ghost history-list__retry";
      retryBtn.type = "button";
      retryBtn.textContent = "重試";
      retryBtn.addEventListener("click", loadHistoryList);
      errLi.appendChild(errText);
      errLi.appendChild(retryBtn);
      listEl.appendChild(errLi);
    }
  }

  function renderHistoryList(meetings, modal) {
    if (!modal) modal = $("historyModal");
    if (!modal) return;
    const listEl = modal.querySelector(".history-list");
    if (!listEl) return;
    listEl.innerHTML = "";
    if (meetings.length === 0) {
      const emptyLi = document.createElement("li");
      emptyLi.className = "history-list__empty";
      emptyLi.textContent = "沒有符合的記錄";
      listEl.appendChild(emptyLi);
      return;
    }
    meetings.forEach((m) => {
      const li = document.createElement("li");
      li.className = "history-list__item";
      li.setAttribute("role", "button");
      li.setAttribute("tabindex", "0");

      const titleEl = document.createElement("div");
      titleEl.className = "history-list__title";
      titleEl.textContent = m.title;

      const metaEl = document.createElement("div");
      metaEl.className = "history-list__meta";
      const dateStr = m.created_at
        ? new Date(m.created_at).toLocaleString("zh-Hant-TW", { dateStyle: "short", timeStyle: "short" })
        : "";
      metaEl.textContent = [m.owner, dateStr].filter(Boolean).join(" · ");

      li.appendChild(titleEl);
      li.appendChild(metaEl);

      const openDetail = () => loadHistoryDetail(m.id, modal);
      li.addEventListener("click", openDetail);
      li.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openDetail(); }
      });

      listEl.appendChild(li);
    });
  }

  async function loadHistoryDetail(id, modal) {
    if (!modal) modal = $("historyModal");
    if (!modal) return;
    const listView = modal.querySelector(".history-modal__listView");
    const detailView = modal.querySelector(".history-modal__detailView");
    if (!detailView) return;

    // 切換視圖
    if (listView) listView.hidden = true;
    detailView.hidden = false;
    detailView.innerHTML = "";

    // loading 狀態
    const loadingP = document.createElement("p");
    loadingP.className = "history-detail__loading";
    loadingP.textContent = "載入中…";
    detailView.appendChild(loadingP);

    try {
      const resp = await fetch(`${API_BASE}/api/meetings/${encodeURIComponent(id)}`);
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || errData.detail || `HTTP ${resp.status}`);
      }
      const mtg = await resp.json();
      renderHistoryDetail(mtg, detailView, modal);
    } catch (err) {
      detailView.innerHTML = "";
      const errP = document.createElement("p");
      errP.className = "history-detail__error";
      errP.textContent = `載入失敗:${err.message || err}`;
      detailView.appendChild(errP);

      const backBtn = document.createElement("button");
      backBtn.className = "btn ghost history-detail__back";
      backBtn.type = "button";
      backBtn.textContent = "← 返回列表";
      backBtn.addEventListener("click", () => showHistoryListView());
      detailView.insertBefore(backBtn, errP);
    }
  }

  function renderHistoryDetail(mtg, detailView, modal) {
    detailView.innerHTML = "";

    // 返回按鈕
    const backBtn = document.createElement("button");
    backBtn.className = "btn ghost history-detail__back";
    backBtn.type = "button";
    backBtn.textContent = "← 返回列表";
    backBtn.addEventListener("click", () => showHistoryListView());
    detailView.appendChild(backBtn);

    // 標題
    const titleEl = document.createElement("h2");
    titleEl.className = "history-detail__title";
    titleEl.textContent = mtg.title;
    detailView.appendChild(titleEl);

    // Meta
    const metaEl = document.createElement("p");
    metaEl.className = "history-detail__meta";
    const dateStr = mtg.created_at
      ? new Date(mtg.created_at).toLocaleString("zh-Hant-TW", { dateStyle: "medium", timeStyle: "short" })
      : "";
    metaEl.textContent = [mtg.owner, dateStr].filter(Boolean).join(" · ");
    detailView.appendChild(metaEl);

    // 重點摘要
    if (mtg.summary) {
      const summaryLabel = document.createElement("h3");
      summaryLabel.className = "history-detail__section-label";
      summaryLabel.textContent = "重點摘要";
      detailView.appendChild(summaryLabel);

      const summaryPre = document.createElement("pre");
      summaryPre.className = "history-detail__summary";
      summaryPre.textContent = mtg.summary;
      detailView.appendChild(summaryPre);
    }

    // 完整逐字稿（折疊）
    if (mtg.transcript) {
      const details = document.createElement("details");
      details.className = "transcript-details history-detail__transcript-details";

      const summary = document.createElement("summary");
      summary.className = "transcript-summary";
      summary.textContent = "完整逐字稿";
      details.appendChild(summary);

      const transcriptPre = document.createElement("pre");
      transcriptPre.className = "history-detail__transcript";
      transcriptPre.textContent = mtg.transcript;
      details.appendChild(transcriptPre);

      detailView.appendChild(details);
    }

    // 建議追問
    const questions = mtg.questions || [];
    if (questions.length > 0) {
      const qLabel = document.createElement("h3");
      qLabel.className = "history-detail__section-label";
      qLabel.textContent = "建議追問";
      detailView.appendChild(qLabel);

      const qList = document.createElement("ol");
      qList.className = "history-detail__questions";
      questions.forEach((item) => {
        const li = document.createElement("li");
        li.className = "history-detail__q-item";

        const qText = document.createElement("p");
        qText.className = "history-detail__q-text";
        qText.textContent = item.q || "";
        li.appendChild(qText);

        if (item.why) {
          const whyText = document.createElement("p");
          whyText.className = "history-detail__q-why";
          whyText.textContent = item.why;
          li.appendChild(whyText);
        }

        qList.appendChild(li);
      });
      detailView.appendChild(qList);
    }
  }

  // ─── 綁定 ────────────────────────────────────────────────────────
  dom.btnStart.addEventListener("click", startRecording);
  dom.btnStop.addEventListener("click", () => stopRecording({ keepTranscript: true, exportAudio: true }));
  dom.btnAsk.addEventListener("click", () => askQuestions({ source: "manual" }));
  dom.btnClear.addEventListener("click", handleClearClick);
  dom.btnDownload.addEventListener("click", downloadTranscript);

  // 存成會議記錄
  if (dom.btnSaveMeeting) {
    dom.btnSaveMeeting.addEventListener("click", showSaveForm);
  }
  const saveMeetingConfirmBtn = $("btnSaveMeetingConfirm");
  if (saveMeetingConfirmBtn) {
    saveMeetingConfirmBtn.addEventListener("click", doSaveMeeting);
  }
  const saveMeetingCancelBtn = $("btnSaveMeetingCancel");
  if (saveMeetingCancelBtn) {
    saveMeetingCancelBtn.addEventListener("click", hideSaveForm);
  }

  // 歷史會議 Modal
  if (dom.btnHistory) {
    dom.btnHistory.addEventListener("click", openHistoryModal);
  }
  const historyModalEl = $("historyModal");
  if (historyModalEl) {
    // 關閉按鈕
    const closeBtn = historyModalEl.querySelector(".history-modal__close");
    if (closeBtn) closeBtn.addEventListener("click", closeHistoryModal);
    // 點 overlay 背景關閉
    historyModalEl.addEventListener("click", (ev) => {
      if (ev.target === historyModalEl) closeHistoryModal();
    });
    // 過濾輸入
    const filterInput = historyModalEl.querySelector(".history-filter");
    if (filterInput) {
      filterInput.addEventListener("input", () => {
        const q = filterInput.value.toLowerCase();
        const filtered = q
          ? _historyAllMeetings.filter((m) => (m.title || "").toLowerCase().includes(q))
          : _historyAllMeetings;
        renderHistoryList(filtered, historyModalEl);
      });
    }
  }

  // 自動產問開關
  if (dom.chkAutoAsk) {
    dom.chkAutoAsk.addEventListener("change", () => {
      state.autoAsk = dom.chkAutoAsk.checked;
      state.linesSinceAutoAsk = 0;
    });
  }

  // 情境範本:點了覆蓋填入 contextHint
  document.querySelectorAll(".preset[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tpl = CONTEXT_PRESETS[btn.dataset.preset];
      if (!tpl || !dom.contextHint) return;
      dom.contextHint.value = tpl;
      dom.contextHint.focus();
      // 標記當前選中的情境(視覺回饋)
      document.querySelectorAll(".preset").forEach((b) =>
        b.classList.toggle("active", b === btn)
      );
    });
  });
  // 手動編輯就清掉選中標記(代表已客製)
  if (dom.contextHint) {
    dom.contextHint.addEventListener("input", () => {
      const cur = dom.contextHint.value;
      const matched = Object.values(CONTEXT_PRESETS).includes(cur);
      if (!matched) {
        document.querySelectorAll(".preset.active").forEach((b) =>
          b.classList.remove("active")
        );
      }
    });
  }

  // 背景設定折疊
  if (dom.btnContextToggle && dom.contextBody) {
    dom.btnContextToggle.addEventListener("click", () => {
      const collapsed = dom.contextBody.hidden;
      dom.contextBody.hidden = !collapsed;
      dom.btnContextToggle.setAttribute("aria-expanded", String(collapsed));
      dom.btnContextToggle.textContent = collapsed ? "收合" : "展開";
    });
  }

  // 逐字稿行點選(事件委派)+ 鍵盤 Enter
  if (dom.transcript) {
    dom.transcript.addEventListener("click", (ev) => {
      const line = ev.target.closest(".line");
      if (line && line.dataset.index !== undefined) {
        handleLineClick(Number(line.dataset.index));
      }
    });
    dom.transcript.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const line = ev.target.closest(".line");
      if (line && line.dataset.index !== undefined) {
        ev.preventDefault();
        handleLineClick(Number(line.dataset.index));
      }
    });
  }

  // 區間提問 / 取消選取
  if (dom.btnAskRange) {
    dom.btnAskRange.addEventListener("click", () => askQuestions({ source: "range" }));
  }
  if (dom.btnClearSel) {
    dom.btnClearSel.addEventListener("click", clearSelection);
  }

  // Chat：表單送出 + Enter 送出（Shift+Enter 換行；IME 組字中不送）
  if (dom.chatForm) {
    dom.chatForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      sendChat();
    });
  }
  if (dom.chatInput) {
    dom.chatInput.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" || ev.shiftKey) return;
      if (ev.isComposing || ev.keyCode === 229) return; // IME 組字中，放行
      ev.preventDefault();
      sendChat();
    });
  }

  // 初始 UI 狀態
  setConn("offline", "待機");
  updateTranscriptStat();
  updateQuestionsStat(0);
  renderDigests();
  renderChatLog();
  refreshAskButton();
  refreshSaveMeetingButton();
})();
