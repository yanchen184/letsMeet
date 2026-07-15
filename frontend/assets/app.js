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
    btnUpload: $("btnUpload"),
    uploadAudioInput: $("uploadAudioInput"),
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
    tplList: $("tplList"),
    btnTplSave: $("btnTplSave"),
    btnTplUpdate: $("btnTplUpdate"),
    btnTplDelete: $("btnTplDelete"),
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
    minutesPanel: $("minutesPanel"),
    minutesBody: $("minutesBody"),
    minutesStat: $("minutesStat"),
    btnDownloadMinutes: $("btnDownloadMinutes"),
    btnRegenMinutes: $("btnRegenMinutes"),
    btnEditMinutes: $("btnEditMinutes"),
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
    autoAsk: true,           // 自動產問開關（預設開）
    linesSinceAutoAsk: 0,    // 距上次自動產問累積的行數
    selAnchor: null,         // 區間選取起點 index;null = 未選
    selFocus: null,          // 區間選取終點 index
    askedThrough: 0,         // 游標:已產問涵蓋到「第幾行之前」(exclusive)。新行 = transcriptLines.slice(askedThrough)
    audioChunks: [],         // 錄音 PCM 累積 [Int16Array, ...]，停止時拼成 WAV
    audioSamples: 0,         // 已累積 sample 數，用來算時長與配置 buffer
    digests: [],             // 重點摘要 [{from, to, summary, edited}]，每次產問順手 append
    digestsEdited: false,    // 使用者改過任一段摘要 → 產問/收尾改用畫面上的摘要當前段脈絡
    chatHistory: [],         // chat 對話 [{role, content}]，只存記憶體
    chatStreaming: false,    // chat 串流進行中，避免重複送出
    fileTimer: null,         // dev 餵檔模式:送幀 setInterval handle,送完/停止時清掉
    fileCloseWatcher: null,  // dev 餵檔模式:idle watchdog,後端轉完才關 WS
    fileLastActivity: 0,     // dev 餵檔模式:最後一次收到後端訊息的時間戳
    uploadAbort: null,       // 上傳音檔轉錄中的 AbortController;null = 沒在轉
    // ── 結束會議收尾 ──
    minutes: "",             // AI 整理出的結構化會議記錄 Markdown
    minutesEditing: false,   // 會議記錄編輯模式中(textarea 取代渲染)
    finalizing: false,       // 收尾流程進行中,避免重複觸發
    finalized: false,        // 已跑過收尾 → 逐字稿唯讀
    meetingDurationSec: 0,   // 這場會議時長(結束時定格,供會議記錄用)
    savedMeetingId: null,    // 這場已歸檔的會議 id;有值則後續存檔/修訂走更新不開新筆
    savedMeetingPin: null,   // 歸檔時設的 PIN,更新同一筆時要帶回驗證
    historySearchTimer: null,// 歷史庫搜尋 debounce handle
    historySearchSeq: 0,     // 搜尋序號,丟棄過期回應(打字快時避免舊結果蓋新結果)
  };

  const RECORD_SAMPLE_RATE = 16000; // 與 AudioWorklet targetSampleRate 一致
  const MIN_LINES_TO_ASK = 3;
  const AUTO_ASK_EVERY_LINES = 8; // 每累積這麼多行,自動產問一次

  // 背景範本改存後端 DB（GET/POST/PUT/DELETE /api/contexts），
  // 原本寫死的四種情境已作為種子資料進 DB，見 backend/app/db.py。

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

  // 非 HTTPS（且非 localhost）時瀏覽器不給麥克風與 AudioWorklet，先擋下來給引導
  function checkRecordingSupport() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      return "瀏覽器只在 HTTPS 頁面開放麥克風。請改用 HTTPS 網址開啟本頁（把網址的 http:// 換成 https://、埠號換成 8444），首次會跳憑證警告，按「進階 → 繼續前往」即可。";
    }
    if (!(window.AudioContext || window.webkitAudioContext)) {
      return "此瀏覽器不支援 Web Audio，無法錄音，請改用新版 Chrome / Edge / Safari。";
    }
    return null;
  }

  async function ensureWorkletReady() {
    if (!state.audioCtx) {
      state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (!state.audioCtx.audioWorklet) {
      throw new Error("此環境不支援 AudioWorklet（通常是非 HTTPS 頁面），請改用 HTTPS 網址");
    }
    if (!state.workletUrl) {
      const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      await state.audioCtx.audioWorklet.addModule(url);
      // addModule 成功才記住,失敗時下次重試不會誤以為已載入
      state.workletUrl = url;
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

  // atSeconds:上傳音檔批次轉錄時帶入「檔案內的真實時間戳」;
  // 省略則沿用即時錄音行為(距開始錄音的牆鐘秒數)。
  function appendTranscriptLine(text, atSeconds) {
    if (!text || !text.trim()) return;
    if (state.transcriptLines.length === 0) {
      dom.transcript.innerHTML = "";
    }
    const t =
      typeof atSeconds === "number" && Number.isFinite(atSeconds)
        ? Math.max(0, Math.floor(atSeconds))
        : Math.floor((Date.now() - state.startEpoch) / 1000);
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
    resetFinalizeState();
    clearSelection();
    dom.transcript.innerHTML =
      '<p class="placeholder">按「錄音」開始即時轉錄。音訊會傳送至內網伺服器處理，不會送往外部雲端服務。</p>';
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
      meta.textContent =
        `第 ${i + 1} 段（第 ${d.from + 1}–${d.to} 行）` +
        (d.edited ? "・已修訂" : "");
      block.appendChild(meta);

      const body = document.createElement("div");
      body.className = "digest-text";
      if (d.pending) {
        body.className = "digest-text digest-pending";
        body.textContent = "摘要產生中…";
        block.appendChild(body);
      } else if (d.summary) {
        body.classList.add("digest-editable");
        body.title = "點擊修改這段摘要";
        body.textContent = d.summary;
        body.addEventListener("click", () => startDigestEdit(d, block, body));
        block.appendChild(body);
      } else {
        // 失敗：顯示佔位 + 重新生成按鈕（只重跑這一段）；也可點擊手動補寫
        body.className = "digest-text digest-failed digest-editable";
        body.title = "點擊手動補寫這段摘要";
        body.textContent = "（這段摘要產生失敗，點擊可手動補寫）";
        body.addEventListener("click", () => startDigestEdit(d, block, body));
        block.appendChild(body);

        const retry = document.createElement("button");
        retry.className = "digest-retry";
        retry.type = "button";
        retry.textContent = "重新生成";
        retry.title = "只重跑這一段的摘要";
        retry.addEventListener("click", () => runDigest(d));
        block.appendChild(retry);
      }
      dom.digestList.appendChild(block);
    });
  }

  // 點擊摘要段落 → 原地換成 textarea 編輯。blur / Cmd(Ctrl)+Enter 存檔，
  // Esc 取消。存檔後標記 edited，後續產問/收尾改用畫面上的摘要當脈絡。
  function startDigestEdit(entry, block, body) {
    if (entry.pending) return;
    const ta = document.createElement("textarea");
    ta.className = "digest-edit";
    ta.value = entry.summary || "";
    ta.rows = Math.max(2, Math.min(10, (ta.value.match(/\n/g) || []).length + 2));
    block.replaceChild(ta, body);
    ta.focus();
    const commit = () => {
      const v = ta.value.trim();
      // 改空 = 取消（避免手滑清掉整段）；有內容且變了才算修訂
      if (v && v !== (entry.summary || "").trim()) {
        entry.summary = v;
        entry.edited = true;
        state.digestsEdited = true;
      }
      renderDigests();
    };
    ta.addEventListener("blur", commit);
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ta.value = entry.summary || "";
        ta.blur();
      } else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
        ta.blur();
      }
    });
  }

  // 畫面上目前的重點摘要全文（含人工修訂）。使用者改過摘要後,
  // 產問的 prior_summary / 收尾的 context 都改用這份,取代後端 rolling cache。
  function joinedDigestSummary() {
    return state.digests.map((d) => d.summary).filter(Boolean).join("\n");
  }

  // 呼叫 /api/digest 填一段摘要；appendDigest 與「重新生成」共用。
  // 進行中 pending=true 由 render 顯示 loading，成功寫 summary，失敗留 null。
  async function runDigest(entry) {
    if (entry.pending) return;
    const text = state.transcriptLines
      .slice(entry.from, entry.to)
      .map((l) => l.text)
      .join(" ");
    if (!text.trim()) return;
    entry.pending = true;
    entry.summary = null;
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
      entry.pending = false;
      renderDigests();
    }
  }

  // 把指定行區間 [from, to) 的逐字稿壓成重點，append 進 state.digests。
  // 失敗不擋主流程，存 summary=null 由 render 顯示佔位 + 重試鈕。
  async function appendDigest(from, to) {
    if (to <= from) return;
    const text = state.transcriptLines
      .slice(from, to)
      .map((l) => l.text)
      .join(" ");
    if (!text.trim()) return;
    const entry = { from, to, summary: null, pending: false };
    state.digests.push(entry);
    await runDigest(entry);
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
    const unsupported = checkRecordingSupport();
    if (unsupported) {
      showError(unsupported, { persistent: true });
      return;
    }
    // 若上一場已收尾，重新開錄視為新一場：清掉會議記錄面板（逐字稿沿用累加）
    if (state.finalized) resetFinalizeState();
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
      if (dom.btnUpload) dom.btnUpload.disabled = true;
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
      if (dom.btnUpload) dom.btnUpload.disabled = false;
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

    // 定格會議時長（供會議記錄用）。上傳音檔沒有 startEpoch，
    // 退而用最後一行逐字稿的檔內時間戳當時長。
    if (state.startEpoch) {
      state.meetingDurationSec = Math.floor((Date.now() - state.startEpoch) / 1000);
    } else if (state.transcriptLines.length > 0) {
      const last = state.transcriptLines[state.transcriptLines.length - 1];
      if (last && Number.isFinite(last.t)) state.meetingDurationSec = last.t;
    }
    stopElapsed();
    setConn("offline", "待機");

    document.body.classList.remove("is-recording");
    dom.btnStart.disabled = false;
    dom.btnStart.textContent = "錄音";
    dom.btnStop.disabled = true;
    dom.btnClear.disabled = false;
    if (dom.btnUpload) dom.btnUpload.disabled = false;
    refreshAskButton();

    if (!keepTranscript) doClearTranscript();
  }

  // ─── DEV:餵錄音檔當即時錄音 ──────────────────────────────────────
  // 把音檔解碼 → resample 16k mono int16 → 切 30ms 包，照真實節奏丟進
  // 同一個 WS /api/stream。後端 / Whisper / 產問鏈路完全沿用,逐字稿是
  // 真的轉出來的。只在 ?devaudio=1 或 Alt+D 顯示入口,不影響正式 UI。
  async function decodeFileTo16kMonoInt16(file) {
    const buf = await file.arrayBuffer();
    const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await tmpCtx.decodeAudioData(buf);
    tmpCtx.close();
    // resample 到 16k mono
    const targetRate = RECORD_SAMPLE_RATE;
    const durationSec = decoded.duration;
    const frameCount = Math.ceil(durationSec * targetRate);
    const offline = new OfflineAudioContext(1, frameCount, targetRate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    const f32 = rendered.getChannelData(0);
    // float [-1,1] → int16
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return i16;
  }

  async function startFilePlayback(file, { realtime = true } = {}) {
    if (state.isRecording) return;
    setConn("connecting", "解碼音檔中");
    dom.btnStart.disabled = true;
    if (dom.btnUpload) dom.btnUpload.disabled = true;
    document.body.classList.add("is-recording");

    let pcm;
    try {
      pcm = await decodeFileTo16kMonoInt16(file);
    } catch (err) {
      console.error(err);
      showError(`音檔解碼失敗:${err.message || err}`, { persistent: true });
      setConn("offline", "待機");
      document.body.classList.remove("is-recording");
      dom.btnStart.disabled = false;
      if (dom.btnUpload) dom.btnUpload.disabled = false;
      return;
    }

    state.ws = new WebSocket(WS_URL);
    state.ws.binaryType = "arraybuffer";
    state.ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === "transcription" && data.text) {
          appendTranscriptLine(data.text);
          state.fileLastActivity = Date.now(); // 收到逐字稿 → 重置 idle 關閉計時
        } else if (data.type === "processing") {
          state.fileLastActivity = Date.now(); // 後端還在轉 → 別關
        } else if (data.type === "error") {
          showError(data.message || "後端錯誤");
        }
      } catch (_) { /* ignore non-JSON frames */ }
    };
    state.ws.onerror = () => {
      showError("WebSocket 錯誤,請檢查後端服務是否啟動", { persistent: true });
    };
    state.ws.onclose = () => {
      if (state.isRecording) stopFilePlayback({ keepTranscript: true });
    };

    state.ws.onopen = () => {
      setConn("recording", "餵檔中");
      state.isRecording = true;
      state.audioChunks = [];
      state.audioSamples = 0;
      if (state.transcriptLines.length === 0) startElapsed();
      dom.btnStop.disabled = false;
      dom.btnStart.textContent = "餵檔中";
      dom.btnClear.disabled = true;
      resetClearConfirm();

      const FRAME = Math.round(RECORD_SAMPLE_RATE * 0.03); // 480 sample = 30ms
      // 背景分頁 setInterval 會被瀏覽器 clamp 到 ~1s,單 tick 送 1 包會慢到沒法用。
      // 改成「每 tick 送約 1 秒音訊(33 包)、tick 間隔 1s」:被 throttle 也維持近即時,
      // 沒被 throttle 則直接快速串流(後端會緩衝,不影響轉錄)。realtime=false 再加倍批量。
      const TICK_MS = 1000;
      const FRAMES_PER_SEC = Math.round(1 / 0.03); // ≈33
      const batch = realtime ? FRAMES_PER_SEC : FRAMES_PER_SEC * 4;
      let offset = 0;
      const sendFrame = () => {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
        for (let b = 0; b < batch && offset < pcm.length; b++) {
          const end = Math.min(offset + FRAME, pcm.length);
          const slice = pcm.slice(offset, end);
          state.audioChunks.push(slice);
          state.audioSamples += slice.length;
          state.ws.send(slice.buffer);
          offset = end;
        }
        if (offset >= pcm.length) {
          clearInterval(state.fileTimer);
          state.fileTimer = null;
          // 全部送完後不能馬上關:後端 CPU 轉錄最後一段(可能十幾秒)還沒回來,
          // 太早關會丟掉結果並觸發 backend "receive after disconnect" error。
          // 改用 idle watchdog:後端持續 GRACE_MS 沒有任何 processing/transcription
          // 訊息才關;每次收到訊息都會把 fileLastActivity 往後推。
          const GRACE_MS = 12000;
          state.fileLastActivity = Date.now();
          state.fileCloseWatcher = setInterval(() => {
            if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
              clearInterval(state.fileCloseWatcher);
              state.fileCloseWatcher = null;
              return;
            }
            if (Date.now() - state.fileLastActivity >= GRACE_MS) {
              clearInterval(state.fileCloseWatcher);
              state.fileCloseWatcher = null;
              try { state.ws.close(); } catch (_) {}
            }
          }, 1000);
        }
      };
      sendFrame(); // 立刻送第一批,不等第一個 tick
      state.fileTimer = setInterval(sendFrame, TICK_MS);
    };
  }

  function stopFilePlayback({ keepTranscript = true } = {}) {
    state.isRecording = false;
    if (state.fileTimer) { clearInterval(state.fileTimer); state.fileTimer = null; }
    if (state.fileCloseWatcher) { clearInterval(state.fileCloseWatcher); state.fileCloseWatcher = null; }
    try { state.ws?.close(); } catch (_) {}
    state.ws = null;
    stopElapsed();
    setConn("offline", "待機");
    document.body.classList.remove("is-recording");
    dom.btnStart.disabled = false;
    dom.btnStart.textContent = "錄音";
    dom.btnStop.disabled = true;
    dom.btnClear.disabled = false;
    if (dom.btnUpload) dom.btnUpload.disabled = false;
    refreshAskButton();
    if (!keepTranscript) doClearTranscript();
  }

  // ─── 上傳音檔:整檔批次轉錄(正式功能) ────────────────────────────
  // 與 dev 餵檔不同:不模擬即時節奏。音檔原始 bytes 直接 POST 給後端,
  // 整檔轉錄的 segments 以 SSE 逐段推回,每段帶檔案內真實時間戳寫入
  // transcriptLines;之後產問/摘要/Chat/儲存鏈路全沿用,跟現場錄的一樣。
  async function uploadAudioFile(file) {
    if (state.isRecording || state.uploadAbort) return;
    const ctrl = new AbortController();
    state.uploadAbort = ctrl;
    setConn("connecting", "上傳音檔中");
    document.body.classList.add("is-recording");
    dom.btnStart.disabled = true;
    dom.btnUpload.disabled = true;
    dom.btnStop.disabled = false;
    dom.btnClear.disabled = true;
    resetClearConfirm();
    let segCount = 0;
    try {
      const resp = await fetch(`${API_BASE}/api/transcribe-file`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Filename": encodeURIComponent(file.name || "upload"),
        },
        body: file,
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        let msg = `上傳失敗(HTTP ${resp.status})`;
        try {
          const body = await resp.json();
          if (body && body.error) msg = body.error;
        } catch (_) { /* 非 JSON 錯誤體,用預設訊息 */ }
        showError(msg, { persistent: true });
        return;
      }
      setConn("recording", "轉錄中");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamError = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop();
        for (const ev of events) {
          const line = ev.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          let obj;
          try { obj = JSON.parse(payload); } catch (_) { continue; }
          if (obj.type === "segment" && obj.text) {
            appendTranscriptLine(obj.text, obj.t);
            segCount += 1;
            setConn("recording", `轉錄中 ${segCount} 段`);
          } else if (obj.type === "error") {
            streamError = obj.message || "轉錄失敗";
          }
        }
      }
      if (streamError) showError(streamError, { persistent: true });
    } catch (err) {
      if (err && err.name === "AbortError") {
        // 使用者按「停止」中斷:已轉出的段落保留,不當錯誤
      } else {
        console.error(err);
        showError("上傳或轉錄失敗,請檢查後端服務", { persistent: true });
      }
    } finally {
      state.uploadAbort = null;
      // 上傳路徑沒有 startEpoch:用最後一行逐字稿的檔內時間戳定格會議時長
      if (state.transcriptLines.length > 0) {
        const last = state.transcriptLines[state.transcriptLines.length - 1];
        if (last && Number.isFinite(last.t) && last.t > 0) {
          state.meetingDurationSec = last.t;
        }
      }
      setConn("offline", "待機");
      document.body.classList.remove("is-recording");
      dom.btnStart.disabled = false;
      dom.btnUpload.disabled = false;
      dom.btnStop.disabled = true;
      dom.btnClear.disabled = false;
      refreshAskButton();
      // 上傳轉錄完成後自動跑 AI 收尾（會議記錄），跟錄音按「停止」的行為對稱。
      // segCount > 0:這次上傳真的有轉出段落才收尾，避免上傳失敗時拿舊逐字稿重跑。
      if (segCount > 0 && state.transcriptLines.length > 0) {
        setTimeout(() => finalizeMeeting(), 800);
      }
    }
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
      // 增量:只送新行,舊內容當背景。
      // 使用者改過重點摘要 → 改用畫面上的摘要(含修訂)當前段脈絡,
      // 後端 rolling cache 不含人工修訂,不能再用。
      transcript = getRecentTranscript();
      priorSummary = state.digestsEdited
        ? joinedDigestSummary() || state.priorSummary
        : state.priorSummary;
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
          // 最近 4 則問 AI 對話當脈絡:反映使用者當下在意的重點，引導追問方向
          recent_chat: state.chatHistory
            .slice(-4)
            .map((m) => ({ role: m.role, content: m.content })),
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

  // 清空 / 重新開錄時，把收尾面板與狀態歸零
  function resetFinalizeState() {
    state.minutes = "";
    state.minutesEditing = false;
    state.finalizing = false;
    state.finalized = false;
    state.meetingDurationSec = 0;
    state.savedMeetingId = null;
    state.savedMeetingPin = null;
    document.body.classList.remove("is-finalized");
    if (dom.minutesPanel) dom.minutesPanel.hidden = true;
    if (dom.minutesBody) dom.minutesBody.innerHTML = "";
    setMinutesStat("—");
    if (dom.btnDownloadMinutes) dom.btnDownloadMinutes.disabled = true;
    if (dom.btnRegenMinutes) dom.btnRegenMinutes.disabled = true;
    if (dom.btnEditMinutes) {
      dom.btnEditMinutes.disabled = true;
      dom.btnEditMinutes.textContent = "編輯";
    }
  }

  // ─── 結束會議：跑一次 AI 收尾 → 產生完整會議記錄 ──────────────────
  // 按「結束」後呼叫：① 補產最後一批問題（全文）②/api/minutes 整理結構化
  // 會議記錄 ③ 呈現可下載面板 ④ 逐字稿轉唯讀。失敗不擋，可「重新整理」重跑。
  async function finalizeMeeting() {
    if (state.finalizing) return;
    const transcript = getFullTranscript();
    if (!transcript.trim()) return; // 沒逐字稿不收尾

    state.finalizing = true;
    // 面板亮出來、標記唯讀
    state.finalized = true;
    document.body.classList.add("is-finalized");
    if (dom.minutesPanel) dom.minutesPanel.hidden = false;
    setMinutesStat("整理中…");
    if (dom.minutesBody) {
      dom.minutesBody.innerHTML =
        '<p class="minutes-loading">AI 正在整理整場逐字稿為會議記錄…</p>';
    }
    if (dom.btnDownloadMinutes) dom.btnDownloadMinutes.disabled = true;
    if (dom.btnRegenMinutes) dom.btnRegenMinutes.disabled = true;
    if (dom.btnEditMinutes) dom.btnEditMinutes.disabled = true;
    state.minutesEditing = false;
    refreshAskButton();

    // ① 全文補產一批問題（沒新行就不動）。不擋主流程，失敗吞掉。
    try {
      if (state.transcriptLines.length >= MIN_LINES_TO_ASK) {
        await askQuestions({ source: "auto" });
      }
    } catch (_e) { /* 產問失敗不影響會議記錄 */ }

    // ② 產結構化會議記錄。使用者改過重點摘要 → 附進 context 要 AI 以修訂版為準
    try {
      const resp = await fetch(`${API_BASE}/api/minutes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript, context: buildMinutesContext() }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      state.minutes = (data.minutes || "").trim();
      renderMinutes();
      setMinutesStat("已完成");
      if (dom.btnDownloadMinutes) dom.btnDownloadMinutes.disabled = !state.minutes;
      if (dom.btnEditMinutes) dom.btnEditMinutes.disabled = !state.minutes;
      // ③ 自動歸檔進會議庫(失敗不擋,狀態列提示可手動存)
      await autoArchiveMeeting();
    } catch (err) {
      console.error("minutes failed", err);
      state.minutes = "";
      if (dom.minutesBody) {
        dom.minutesBody.innerHTML =
          '<p class="minutes-error">會議記錄產生失敗，可按「重新整理」重試。' +
          '（逐字稿與問題已保留，仍可下載）</p>';
      }
      setMinutesStat("失敗");
      // 失敗時仍允許下載（用逐字稿+問題組，minutes 段標註失敗）
      if (dom.btnDownloadMinutes) dom.btnDownloadMinutes.disabled = false;
      if (dom.btnEditMinutes) dom.btnEditMinutes.disabled = true;
    } finally {
      state.finalizing = false;
      if (dom.btnRegenMinutes) dom.btnRegenMinutes.disabled = false;
      refreshAskButton();
    }
  }

  function setMinutesStat(text) {
    if (dom.minutesStat) dom.minutesStat.textContent = text;
  }

  // 收尾用 context：一般背景 + （若有）人工修訂過的重點摘要,要 AI 以修訂版為準
  function buildMinutesContext() {
    const base = buildContext();
    if (!state.digestsEdited) return base;
    const revised = joinedDigestSummary();
    if (!revised) return base;
    const block = `【人工修訂重點摘要（與逐字稿出入時以此為準）】\n${revised}`;
    return base ? `${base}\n\n${block}` : block;
  }

  // ─── 結束會議自動歸檔（Task 17）────────────────────────────────
  // finalize 成功後自動存進會議庫,不用等使用者按「儲存會議」。
  // 標題用 /api/title 產(失敗退日期時間),owner 用上次存檔記的名字(沒有就「未署名」)。
  // 已歸檔過(含手動存過)→ 更新同一筆,不開新筆。
  function buildArchiveContents() {
    return {
      summary: joinedDigestSummary() || null,
      transcript: getFullTranscript() || null,
      questions: state.questionItems.length
        ? state.questionItems.map((it) => ({ q: it.q, why: it.why }))
        : null,
      minutes: state.minutes || null,
    };
  }

  async function autoArchiveMeeting() {
    try {
      if (state.savedMeetingId) {
        const resp = await fetch(`${API_BASE}/api/meetings/${state.savedMeetingId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...buildArchiveContents(), pin: state.savedMeetingPin || null }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        setMinutesStat(`已完成・歸檔 #${state.savedMeetingId} 已更新`);
        extractActionItems(state.savedMeetingId);
      } else {
        const title = await generateArchiveTitle();
        const owner = localStorage.getItem(LS_OWNER_KEY) || "未署名";
        const resp = await fetch(`${API_BASE}/api/meetings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            owner,
            context: buildContext(),
            ...buildArchiveContents(),
          }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        state.savedMeetingId = data.id;
        setMinutesStat(`已完成・已自動歸檔 #${data.id}`);
        extractActionItems(data.id);
      }
    } catch (err) {
      console.error("auto archive failed", err);
      setMinutesStat("已完成・自動歸檔失敗,可按「儲存會議」手動存");
    }
  }

  // 歸檔後非阻塞抽待辦：從逐字稿抽結構化待辦寫進該會議（失敗只記 log，不擋主流程）。
  function extractActionItems(meetingId) {
    const transcript = getFullTranscript();
    if (!transcript.trim()) return;
    fetch(`${API_BASE}/api/meetings/${meetingId}/action-items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript,
        context: buildContext(),
        pin: state.savedMeetingPin || null,
      }),
    })
      .then((r) => r.json().catch(() => ({})))
      .then((d) => {
        const n = (d.action_items || []).length;
        if (n > 0) console.info(`已抽出 ${n} 筆待辦 → 會議 #${meetingId}`);
      })
      .catch((err) => console.error("extract action items failed", err));
  }

  async function generateArchiveTitle() {
    const transcript = getFullTranscript();
    if (transcript.trim()) {
      try {
        const resp = await fetch(`${API_BASE}/api/title`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript }),
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && data.title) return data.title;
      } catch (_e) { /* 退 fallback */ }
    }
    const d = new Date();
    return `會議 ${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // 會議記錄修訂後,同步回已歸檔那筆(沒歸檔就不動)
  async function syncMinutesToArchive() {
    if (!state.savedMeetingId) return;
    try {
      const resp = await fetch(`${API_BASE}/api/meetings/${state.savedMeetingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          minutes: state.minutes || null,
          pin: state.savedMeetingPin || null,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setMinutesStat(`已修訂・歸檔 #${state.savedMeetingId} 已同步`);
    } catch (err) {
      console.error("sync minutes to archive failed", err);
      setMinutesStat("已修訂・歸檔同步失敗");
    }
  }

  // ─── 會議記錄編輯模式：textarea 取代渲染,存檔寫回 state.minutes ──
  function startMinutesEdit() {
    if (!dom.minutesBody || state.finalizing || state.minutesEditing) return;
    if (!state.minutes) return;
    state.minutesEditing = true;
    const ta = document.createElement("textarea");
    ta.className = "minutes-edit";
    ta.id = "minutesEditArea";
    ta.value = state.minutes;
    dom.minutesBody.innerHTML = "";
    dom.minutesBody.appendChild(ta);
    ta.focus();
    // 編輯中避免下載到未存檔內容 / 重新整理蓋掉編輯
    if (dom.btnDownloadMinutes) dom.btnDownloadMinutes.disabled = true;
    if (dom.btnRegenMinutes) dom.btnRegenMinutes.disabled = true;
    if (dom.btnEditMinutes) dom.btnEditMinutes.textContent = "儲存修改";
    setMinutesStat("編輯中…");
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") cancelMinutesEdit();
      else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) commitMinutesEdit();
    });
  }

  function endMinutesEdit(statText) {
    state.minutesEditing = false;
    renderMinutes();
    setMinutesStat(statText);
    if (dom.btnDownloadMinutes) dom.btnDownloadMinutes.disabled = !state.minutes;
    if (dom.btnRegenMinutes) dom.btnRegenMinutes.disabled = false;
    if (dom.btnEditMinutes) dom.btnEditMinutes.textContent = "編輯";
  }

  function commitMinutesEdit() {
    const ta = $("minutesEditArea");
    if (!ta) return;
    const v = ta.value.trim();
    const changed = v && v !== state.minutes.trim();
    if (changed) state.minutes = v;
    endMinutesEdit(changed ? "已修訂" : "已完成");
    if (changed) syncMinutesToArchive();
  }

  function cancelMinutesEdit() {
    endMinutesEdit("已完成");
  }

  // 把 minutes Markdown 以極簡方式渲染（標題 + 條列），不引入 md 函式庫
  function renderMinutes() {
    if (!dom.minutesBody) return;
    if (!state.minutes) {
      dom.minutesBody.innerHTML =
        '<p class="minutes-error">尚無會議記錄。</p>';
      return;
    }
    dom.minutesBody.innerHTML = "";
    renderMinutesInto(dom.minutesBody, state.minutes);
  }

  // 極簡 Markdown 渲染共用：收尾面板與歷史詳情都用
  function renderMinutesInto(container, text) {
    text.split("\n").forEach((raw) => {
      const line = raw.trimEnd();
      if (!line.trim()) return;
      let el;
      if (/^#{1,6}\s/.test(line)) {
        el = document.createElement("h3");
        el.className = "minutes-h";
        el.textContent = line.replace(/^#{1,6}\s+/, "");
      } else if (/^[-*]\s/.test(line)) {
        el = document.createElement("div");
        el.className = "minutes-li";
        el.textContent = line.replace(/^[-*]\s+/, "");
      } else {
        el = document.createElement("p");
        el.className = "minutes-p";
        el.textContent = line;
      }
      container.appendChild(el);
    });
  }

  // 組出完整會議記錄 Markdown（標題/日期/時長/摘要/問題/逐字稿）並下載
  function downloadMinutes() {
    if (state.transcriptLines.length === 0) {
      showError("沒有可下載的內容");
      return;
    }
    const now = new Date();
    const durSec = state.meetingDurationSec || 0;
    const questions = state.questionItems || [];
    const lines = [];
    lines.push(`# 會議記錄`);
    lines.push(``);
    lines.push(`- 產生時間：${now.toLocaleString()}`);
    if (durSec > 0) lines.push(`- 會議時長：${fmtElapsedLong(durSec)}`);
    const ctx = buildContext();
    if (ctx && ctx.trim()) {
      lines.push(`- 會議背景：${ctx.trim().replace(/\n/g, " ")}`);
    }
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
    // 重點摘要（AI 整理的結構化會議記錄）
    if (state.minutes) {
      lines.push(state.minutes);
    } else {
      lines.push(`## 會議重點`);
      lines.push(`（AI 會議記錄產生失敗，以下為逐字稿原文）`);
    }
    lines.push(``);
    // 待釐清問題清單
    if (questions.length) {
      lines.push(`## 建議追問`);
      questions.forEach((it, i) => {
        lines.push(`${i + 1}. ${it.q}`);
        if (it.why) lines.push(`   - 為什麼問：${it.why}`);
      });
      lines.push(``);
    }
    // 完整逐字稿（附時間）
    lines.push(`## 完整逐字稿`);
    state.transcriptLines.forEach((l) => {
      lines.push(`- [${fmtElapsed(l.t)}] ${l.text}`);
    });
    lines.push(``);

    const md = lines.join("\n");
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = buildMeetingFilename("md");
    a.click();
    URL.revokeObjectURL(url);
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
  const LS_CONTEXT_ROLE_KEY = "letsmeet_context_role";
  const LS_CONTEXT_INFO_KEY = "letsmeet_context_info";

  function refreshSaveMeetingButton() {
    if (!dom.btnSaveMeeting) return;
    const hasContent = state.transcriptLines.length > 0 || state.questionItems.length > 0;
    dom.btnSaveMeeting.disabled = !hasContent;

    // 暫停(非錄音中)且有內容、且尚未開存檔表單 → 發波浪光提示「該存了」
    const formEl = $("saveMeetingForm");
    const formOpen = formEl && !formEl.hidden;
    const shouldHint = hasContent && !state.isRecording && !formOpen;
    dom.btnSaveMeeting.classList.toggle("is-ready", shouldHint);
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
    // 開表單 → 按鈕的提示光熄掉（提示已達成目的）
    refreshSaveMeetingButton();

    // 畫面拉到最下面的儲存表單，並用波浪光強調
    formEl.scrollIntoView({ behavior: "smooth", block: "end" });
    formEl.classList.remove("is-flash");
    // reflow 後重新加，確保每次按都重播動畫
    void formEl.offsetWidth;
    formEl.classList.add("is-flash");
    setTimeout(() => formEl.classList.remove("is-flash"), 3800);

    const titleInput = $("saveMeetingTitle");
    if (titleInput) titleInput.focus();
    // 標題還空著 → 用逐字稿自動產一個預填（使用者可改）
    autofillTitle();
  }

  // 開儲存表單時，若標題仍空且有逐字稿，呼叫 /api/title 自動預填。
  // 使用者一旦自己打字就不覆蓋；產生中以 placeholder 提示。
  async function autofillTitle() {
    const titleInput = $("saveMeetingTitle");
    if (!titleInput || titleInput.value.trim()) return;  // 已有內容不動
    const transcript = getFullTranscript();
    if (!transcript || !transcript.trim()) return;       // 沒逐字稿不產

    const badge = $("titleAiBadge");
    if (badge) badge.hidden = false;
    titleInput.classList.add("is-ai-loading");
    try {
      const resp = await fetch(`${API_BASE}/api/title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript }),
      });
      const data = await resp.json().catch(() => ({}));
      // 僅在「使用者這段期間沒自己打字」時才填，避免蓋掉手動輸入
      if (resp.ok && data.title && !titleInput.value.trim()) {
        titleInput.value = data.title;
      }
    } catch (_e) {
      // 產失敗就讓使用者自己打，不擋存檔
    } finally {
      if (badge) badge.hidden = true;
      titleInput.classList.remove("is-ai-loading");
    }
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
    const pinInput = $("saveMeetingPin");
    const title = (titleInput?.value || "").trim();
    const owner = (ownerInput?.value || "").trim();
    const pin = (pinInput?.value || "").trim();

    if (!title || !owner) {
      setSaveMsg("標題與填寫者必填", true);
      return;
    }
    if (pin && !/^\d{4}$/.test(pin)) {
      setSaveMsg("PIN 請輸入 4 位數字", true);
      return;
    }

    const confirmBtn = $("btnSaveMeetingConfirm");
    if (confirmBtn) confirmBtn.disabled = true;

    try {
      // 已自動歸檔過 → 更新同一筆(標題/owner/PIN 以表單為準),不開新筆
      const isUpdate = !!state.savedMeetingId;
      const url = isUpdate
        ? `${API_BASE}/api/meetings/${state.savedMeetingId}`
        : `${API_BASE}/api/meetings`;
      const body = {
        title,
        owner,
        ...buildArchiveContents(),
      };
      if (isUpdate) {
        body.pin = state.savedMeetingPin || null;
        if (pin) body.pin_code = pin; // 空欄不動既有 PIN
      } else {
        body.context = buildContext();
        body.pin_code = pin || null;
      }
      const resp = await fetch(url, {
        method: isUpdate ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setSaveMsg(data.error || `儲存失敗 (HTTP ${resp.status})`, true);
        return;
      }
      // success
      if (data.id) state.savedMeetingId = data.id;
      state.savedMeetingPin = pin || null;
      localStorage.setItem(LS_OWNER_KEY, owner);
      setSaveMsg(isUpdate ? "已更新歸檔 ✓" : "已存檔 ✓", false);
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
    // 重置分頁回「會議列表」
    switchHistoryTab("meetings", modal);
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
      // 列表全公開:不帶 owner，後端回全部會議（內容仍由 PIN 保護）
      const resp = await fetch(`${API_BASE}/api/meetings`);
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
      // 全文搜尋回的命中片段：[ ] 標記命中處,渲染成 <mark> 高亮
      if (m.snippet) {
        const snipEl = document.createElement("div");
        snipEl.className = "history-list__snippet";
        appendSnippet(snipEl, m.snippet);
        li.appendChild(snipEl);
      }
      const isProtected = !!(m.is_protected || m.pin_protected);
      if (isProtected) {
        const lockEl = document.createElement("span");
        lockEl.className = "history-list__lock";
        lockEl.textContent = "PIN 保護";
        li.appendChild(lockEl);
      }

      const openDetail = () => {
        if (isProtected) {
          promptPinThenLoad(m.id, m.title, modal);
        } else {
          loadHistoryDetail(m.id, modal);
        }
      };
      li.addEventListener("click", openDetail);
      li.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openDetail(); }
      });

      listEl.appendChild(li);
    });
  }

  // 把後端 FTS snippet(命中處用 [ ] 包住)安全渲染進 container:
  // 逐段拆解、命中片段包成 <mark>,其餘用 textContent,避免任何 HTML 注入。
  function appendSnippet(container, snippet) {
    const text = String(snippet || "");
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("[", i);
      if (open === -1) {
        container.appendChild(document.createTextNode(text.slice(i)));
        break;
      }
      if (open > i) {
        container.appendChild(document.createTextNode(text.slice(i, open)));
      }
      const close = text.indexOf("]", open + 1);
      if (close === -1) {
        // 沒有對應的 ] → 剩下的當純文字
        container.appendChild(document.createTextNode(text.slice(open)));
        break;
      }
      const mark = document.createElement("mark");
      mark.className = "history-list__hit";
      mark.textContent = text.slice(open + 1, close);
      container.appendChild(mark);
      i = close + 1;
    }
  }

  // 打後端 FTS 全文搜尋。用 historySearchSeq 丟棄過期回應(打字快時舊結果別蓋新的)。
  async function runHistorySearch(q) {
    const modal = $("historyModal");
    if (!modal) return;
    const listEl = modal.querySelector(".history-list");
    if (!listEl) return;

    const seq = ++state.historySearchSeq;
    listEl.innerHTML = "";
    const loadingLi = document.createElement("li");
    loadingLi.className = "history-list__loading";
    loadingLi.textContent = "搜尋中…";
    listEl.appendChild(loadingLi);

    try {
      const url = `${API_BASE}/api/meetings/search?q=${encodeURIComponent(q)}&limit=50`;
      const resp = await fetch(url);
      if (seq !== state.historySearchSeq) return; // 過期回應,丟棄
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      renderHistoryList(data.meetings || [], modal);
    } catch (err) {
      if (seq !== state.historySearchSeq) return;
      listEl.innerHTML = "";
      const errLi = document.createElement("li");
      errLi.className = "history-list__error";
      errLi.textContent = `搜尋失敗:${err.message || err}`;
      listEl.appendChild(errLi);
    }
  }

  // ─── 待辦追蹤看板（跨會議未結）─────────────────────────────────────
  function switchHistoryTab(tab, modal) {
    if (!modal) modal = $("historyModal");
    if (!modal) return;
    modal.querySelectorAll(".history-tab").forEach((btn) => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    modal.querySelectorAll(".history-tabpanel").forEach((p) => {
      p.hidden = p.dataset.panel !== tab;
    });
    if (tab === "actions") loadActionBoard(modal);
  }

  async function loadActionBoard(modal) {
    if (!modal) modal = $("historyModal");
    if (!modal) return;
    const listEl = modal.querySelector(".history-actions");
    if (!listEl) return;
    listEl.innerHTML = "";
    const loadingLi = document.createElement("li");
    loadingLi.className = "history-list__loading";
    loadingLi.textContent = "載入中…";
    listEl.appendChild(loadingLi);
    try {
      const resp = await fetch(`${API_BASE}/api/action-items?status=open`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      renderActionBoard(data.action_items || [], modal);
    } catch (err) {
      listEl.innerHTML = "";
      const errLi = document.createElement("li");
      errLi.className = "history-list__error";
      errLi.textContent = `載入失敗:${err.message || err}`;
      listEl.appendChild(errLi);
    }
  }

  function renderActionBoard(items, modal) {
    const listEl = modal.querySelector(".history-actions");
    if (!listEl) return;
    listEl.innerHTML = "";
    if (items.length === 0) {
      const emptyLi = document.createElement("li");
      emptyLi.className = "history-list__empty";
      emptyLi.textContent = "目前沒有未結待辦 🎉";
      listEl.appendChild(emptyLi);
      return;
    }
    items.forEach((it) => {
      const li = document.createElement("li");
      li.className = "action-item";

      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.className = "action-item__check";
      chk.title = "打勾結案";
      chk.addEventListener("change", () => closeActionItem(it.id, li, chk, modal));

      const body = document.createElement("div");
      body.className = "action-item__body";

      const taskEl = document.createElement("div");
      taskEl.className = "action-item__task";
      const tags = [];
      if (it.assignee) tags.push(`[${it.assignee}]`);
      tags.push(it.task);
      if (it.due) tags.push(`（${it.due}）`);
      taskEl.textContent = tags.join(" ");

      const metaEl = document.createElement("div");
      metaEl.className = "action-item__meta";
      metaEl.textContent = `來自：${it.meeting_title || "會議 #" + it.meeting_id}`;

      body.appendChild(taskEl);
      body.appendChild(metaEl);
      li.appendChild(chk);
      li.appendChild(body);
      listEl.appendChild(li);
    });
  }

  async function closeActionItem(itemId, li, chk, modal) {
    chk.disabled = true;
    try {
      const resp = await fetch(`${API_BASE}/api/action-items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      // 淡出移除,若清空則顯示空狀態
      li.classList.add("action-item--done");
      setTimeout(() => {
        li.remove();
        const listEl = modal.querySelector(".history-actions");
        if (listEl && listEl.children.length === 0) renderActionBoard([], modal);
      }, 350);
    } catch (err) {
      console.error("close action item failed", err);
      chk.checked = false;
      chk.disabled = false;
    }
  }

  // 受保護會議：先在 detailView 顯示 PIN 輸入，驗證通過才載入內容。
  function promptPinThenLoad(id, title, modal, errMsg) {
    if (!modal) modal = $("historyModal");
    if (!modal) return;
    const listView = modal.querySelector(".history-modal__listView");
    const detailView = modal.querySelector(".history-modal__detailView");
    if (!detailView) return;

    if (listView) listView.hidden = true;
    detailView.hidden = false;
    detailView.innerHTML = "";

    const backBtn = document.createElement("button");
    backBtn.className = "btn ghost history-detail__back";
    backBtn.type = "button";
    backBtn.textContent = "← 返回列表";
    backBtn.addEventListener("click", () => showHistoryListView());
    detailView.appendChild(backBtn);

    const form = document.createElement("form");
    form.className = "history-detail__pin-form";

    const label = document.createElement("label");
    label.className = "history-detail__pin-label";
    label.textContent = title ? `「${title}」受 PIN 保護，請輸入 4 位數 PIN` : "請輸入 4 位數 PIN";
    form.appendChild(label);

    const input = document.createElement("input");
    input.className = "save-meeting-form__input pin-input";
    input.type = "text";
    input.inputMode = "numeric";
    input.maxLength = 4;
    input.pattern = "[0-9]{4}";
    input.placeholder = "••••";
    form.appendChild(input);

    const submit = document.createElement("button");
    submit.className = "btn primary";
    submit.type = "submit";
    submit.textContent = "解鎖";
    form.appendChild(submit);

    if (errMsg) {
      const errP = document.createElement("p");
      errP.className = "history-detail__error";
      errP.textContent = errMsg;
      form.appendChild(errP);
    }

    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const pin = (input.value || "").trim();
      if (!/^\d{4}$/.test(pin)) {
        return promptPinThenLoad(id, title, modal, "PIN 請輸入 4 位數字");
      }
      loadHistoryDetail(id, modal, pin, title);
    });

    detailView.appendChild(form);
    input.focus();
  }

  async function loadHistoryDetail(id, modal, pin, title) {
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
      const qs = pin ? `?pin=${encodeURIComponent(pin)}` : "";
      const resp = await fetch(`${API_BASE}/api/meetings/${encodeURIComponent(id)}${qs}`);
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        // PIN 錯誤/未提供 → 回到輸入畫面允許重試
        if (resp.status === 401 || errData.pin_required) {
          return promptPinThenLoad(id, title, modal, "PIN 錯誤，請再試一次");
        }
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

    // AI 會議記錄（自動歸檔存的結構化 Markdown）
    if (mtg.minutes) {
      const minutesLabel = document.createElement("h3");
      minutesLabel.className = "history-detail__section-label";
      minutesLabel.textContent = "會議記錄";
      detailView.appendChild(minutesLabel);

      const minutesDiv = document.createElement("div");
      minutesDiv.className = "history-detail__minutes";
      renderMinutesInto(minutesDiv, mtg.minutes);
      detailView.appendChild(minutesDiv);
    }

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
  dom.btnStop.addEventListener("click", () => {
    // 上傳轉錄中 → 中斷 fetch(已轉出段落保留);餵檔模式用 fileTimer 區分;
    // 一般錄音才匯出 WAV
    if (state.uploadAbort) { state.uploadAbort.abort(); return; }
    if (state.fileTimer) stopFilePlayback({ keepTranscript: true });
    else stopRecording({ keepTranscript: true, exportAudio: true });
    // 停止後補一小段延遲讓最後一段逐字稿落地，再跑 AI 收尾產會議記錄。
    // 若尾段來得晚沒收進來，使用者可按「重新整理」重跑。
    setTimeout(() => {
      if (state.transcriptLines.length > 0) finalizeMeeting();
    }, 1200);
  });

  // 會議記錄下載 / 重新整理
  if (dom.btnDownloadMinutes) {
    dom.btnDownloadMinutes.addEventListener("click", downloadMinutes);
  }
  if (dom.btnEditMinutes) {
    dom.btnEditMinutes.addEventListener("click", () => {
      if (state.minutesEditing) commitMinutesEdit();
      else startMinutesEdit();
    });
  }
  if (dom.btnRegenMinutes) {
    dom.btnRegenMinutes.addEventListener("click", () => finalizeMeeting());
  }

  // 上傳音檔 → 整檔批次轉錄
  if (dom.btnUpload && dom.uploadAudioInput) {
    dom.btnUpload.addEventListener("click", () => dom.uploadAudioInput.click());
    dom.uploadAudioInput.addEventListener("change", () => {
      const f = dom.uploadAudioInput.files && dom.uploadAudioInput.files[0];
      if (f) uploadAudioFile(f);
      dom.uploadAudioInput.value = "";
    });
  }

  // ─── DEV 餵檔入口:?devaudio=1 或 Alt+D 顯示一顆按鈕 ──────────────
  (function setupDevAudio() {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "audio/*";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) startFilePlayback(f, { realtime: true });
      fileInput.value = "";
    });
    document.body.appendChild(fileInput);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "🎵 餵錄音檔";
    btn.title = "DEV:選一個音檔當即時錄音餵進 Whisper";
    btn.style.cssText =
      "position:fixed;left:12px;bottom:48px;z-index:9999;padding:6px 10px;" +
      "font-size:12px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;" +
      "color:#334155;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.12)";
    btn.addEventListener("click", () => fileInput.click());

    const show = () => { if (!btn.isConnected) document.body.appendChild(btn); };
    if (new URLSearchParams(location.search).has("devaudio")) show();
    document.addEventListener("keydown", (e) => {
      if (e.altKey && (e.key === "d" || e.key === "D")) { e.preventDefault(); show(); }
    });
  })();
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
    // 搜尋輸入：打後端 FTS 全文搜尋（跨標題/摘要/逐字稿/會議記錄/追問），debounce 250ms。
    // 空字串 → 回全部列表。
    const filterInput = historyModalEl.querySelector(".history-filter");
    if (filterInput) {
      filterInput.addEventListener("input", () => {
        const q = filterInput.value.trim();
        clearTimeout(state.historySearchTimer);
        if (!q) {
          renderHistoryList(_historyAllMeetings, historyModalEl);
          return;
        }
        state.historySearchTimer = setTimeout(() => runHistorySearch(q), 250);
      });
    }
    // 分頁切換：會議列表 / 待辦追蹤
    historyModalEl.querySelectorAll(".history-tab").forEach((btn) => {
      btn.addEventListener("click", () => switchHistoryTab(btn.dataset.tab, historyModalEl));
    });
  }

  // 自動產問開關
  if (dom.chkAutoAsk) {
    dom.chkAutoAsk.addEventListener("change", () => {
      state.autoAsk = dom.chkAutoAsk.checked;
      state.linesSinceAutoAsk = 0;
    });
  }

  // 還原上次填的會議背景(我的角色與重點 / 會議資訊)
  if (dom.contextHint) {
    const savedRole = localStorage.getItem(LS_CONTEXT_ROLE_KEY);
    if (savedRole) dom.contextHint.value = savedRole;
  }
  if (dom.meetingInfo) {
    const savedInfo = localStorage.getItem(LS_CONTEXT_INFO_KEY);
    if (savedInfo) dom.meetingInfo.value = savedInfo;
  }

  // ─── 會議背景範本庫：DB 共用，可套用 / 新增 / 更新 / 刪除 ──────────
  const tplState = { items: [], activeId: null };

  function refreshTplActions() {
    const hasActive = tplState.activeId != null;
    if (dom.btnTplUpdate) dom.btnTplUpdate.disabled = !hasActive;
    if (dom.btnTplDelete) dom.btnTplDelete.disabled = !hasActive;
  }

  function setActiveTemplate(id) {
    tplState.activeId = id;
    if (dom.tplList) {
      dom.tplList.querySelectorAll(".preset").forEach((b) =>
        b.classList.toggle("active", Number(b.dataset.tplId) === id)
      );
    }
    refreshTplActions();
  }

  function applyTemplate(tpl) {
    if (!dom.contextHint) return;
    dom.contextHint.value = tpl.role_text || "";
    localStorage.setItem(LS_CONTEXT_ROLE_KEY, dom.contextHint.value);
    // 會議資訊常是每場不同,範本這欄沒填就保留使用者現有內容
    if (tpl.goal_text && dom.meetingInfo) {
      dom.meetingInfo.value = tpl.goal_text;
      localStorage.setItem(LS_CONTEXT_INFO_KEY, tpl.goal_text);
    }
    setActiveTemplate(tpl.id);
    dom.contextHint.focus();
  }

  function renderTemplates() {
    if (!dom.tplList) return;
    dom.tplList.textContent = "";
    tplState.items.forEach((tpl) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "preset";
      btn.dataset.tplId = String(tpl.id);
      btn.textContent = tpl.name;
      btn.title = tpl.role_text || tpl.name;
      btn.addEventListener("click", () => applyTemplate(tpl));
      dom.tplList.appendChild(btn);
    });
    setActiveTemplate(tplState.activeId);
  }

  async function loadTemplates() {
    if (!dom.tplList) return;
    try {
      const resp = await fetch(`${API_BASE}/api/contexts`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = await resp.json();
      tplState.items = Array.isArray(body.contexts) ? body.contexts : [];
      renderTemplates();
    } catch (_err) {
      // 非致命:範本載不到仍可手填背景,留個提示就好
      dom.tplList.textContent = "範本載入失敗";
    }
  }

  if (dom.btnTplSave) {
    dom.btnTplSave.addEventListener("click", async () => {
      const role = (dom.contextHint?.value || "").trim();
      const goal = (dom.meetingInfo?.value || "").trim();
      if (!role && !goal) {
        showError("先在下方「我的角色與重點 / 會議資訊」填好內容，再存成範本");
        return;
      }
      const name = (window.prompt("範本名稱：") || "").trim();
      if (!name) return;
      try {
        const resp = await fetch(`${API_BASE}/api/contexts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, role_text: role, goal_text: goal }),
        });
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(body.error || `HTTP ${resp.status}`);
        await loadTemplates();
        setActiveTemplate(body.id);
      } catch (err) {
        showError(`存範本失敗：${err.message}`);
      }
    });
  }

  if (dom.btnTplUpdate) {
    dom.btnTplUpdate.addEventListener("click", async () => {
      const tpl = tplState.items.find((t) => t.id === tplState.activeId);
      if (!tpl) return;
      if (!window.confirm(`用目前填的內容覆蓋範本「${tpl.name}」？`)) return;
      try {
        const resp = await fetch(`${API_BASE}/api/contexts/${tpl.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role_text: (dom.contextHint?.value || "").trim(),
            goal_text: (dom.meetingInfo?.value || "").trim(),
          }),
        });
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(body.error || `HTTP ${resp.status}`);
        await loadTemplates();
        setActiveTemplate(tpl.id);
      } catch (err) {
        showError(`更新範本失敗：${err.message}`);
      }
    });
  }

  if (dom.btnTplDelete) {
    dom.btnTplDelete.addEventListener("click", async () => {
      const tpl = tplState.items.find((t) => t.id === tplState.activeId);
      if (!tpl) return;
      if (!window.confirm(`刪除範本「${tpl.name}」？此動作無法復原。`)) return;
      try {
        const resp = await fetch(`${API_BASE}/api/contexts/${tpl.id}`, {
          method: "DELETE",
        });
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(body.error || `HTTP ${resp.status}`);
        setActiveTemplate(null);
        await loadTemplates();
      } catch (err) {
        showError(`刪除範本失敗：${err.message}`);
      }
    });
  }

  loadTemplates();

  // 編輯內容不取消選中：選中代表「正在操作這個範本」，改完按「更新」才能覆蓋回去。
  if (dom.contextHint) {
    dom.contextHint.addEventListener("input", () => {
      // 記住使用者填的角色與重點
      localStorage.setItem(LS_CONTEXT_ROLE_KEY, dom.contextHint.value);
    });
  }
  // 記住使用者填的會議資訊
  if (dom.meetingInfo) {
    dom.meetingInfo.addEventListener("input", () => {
      localStorage.setItem(LS_CONTEXT_INFO_KEY, dom.meetingInfo.value);
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

  // 關於 letsMeet modal
  const aboutModal = $("aboutModal");
  const btnAbout = $("btnAbout");
  const btnAboutClose = $("btnAboutClose");
  if (btnAbout && aboutModal) {
    const panel = aboutModal.querySelector(".about-modal__panel");
    let aboutLastFocus = null;
    const getFocusable = () => Array.from(aboutModal.querySelectorAll(
      'button:not([disabled]), summary, a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ));
    const openAbout = () => {
      aboutLastFocus = document.activeElement;
      aboutModal.hidden = false;
      document.body.classList.add("modal-open");
      btnAboutClose?.focus();
    };
    const closeAbout = () => {
      aboutModal.hidden = true;
      document.body.classList.remove("modal-open");
      aboutLastFocus?.focus();
    };
    btnAbout.addEventListener("click", openAbout);
    if (btnAboutClose) btnAboutClose.addEventListener("click", closeAbout);
    // 點遮罩背景關閉(點 panel 內不關)
    aboutModal.addEventListener("click", (ev) => {
      if (ev.target === aboutModal) closeAbout();
    });
    // Esc 關閉；Tab 保持在 dialog 內。
    document.addEventListener("keydown", (ev) => {
      if (aboutModal.hidden) return;
      if (ev.key === "Escape") {
        closeAbout();
        return;
      }
      if (ev.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        ev.preventDefault();
        panel?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
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

  // 顯示後端正在用的兩個模型（逐字稿 ASR + AI LLM）
  async function loadModelInfo() {
    const asrEl = $("asrModel");
    const llmEl = $("llmModel");
    if (!asrEl && !llmEl) return;
    try {
      const resp = await fetch(`${API_BASE}/api/health`);
      const data = await resp.json().catch(() => ({}));
      // 模型名常含 org/ 前綴，只取最後一段顯示，hover 看全名
      const shortName = (full) => {
        const s = (full || "").trim();
        return s ? s.split("/").pop() : "—";
      };
      if (asrEl && data.asr_model) {
        asrEl.textContent = shortName(data.asr_model);
        asrEl.title = data.asr_model;
      }
      if (llmEl && data.llm_model) {
        llmEl.textContent = shortName(data.llm_model);
        llmEl.title = data.llm_model;
      }
    } catch (_e) {
      // health 拿不到就維持 "—"，不擋主流程
    }
  }

  // 初始 UI 狀態
  setConn("offline", "待機");
  updateTranscriptStat();
  updateQuestionsStat(0);
  renderDigests();
  renderChatLog();
  refreshAskButton();
  refreshSaveMeetingButton();
  loadModelInfo();
})();
