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
  };

  const MIN_LINES_TO_ASK = 3;

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
    state.transcriptLines.push({ t, text: text.trim() });
    const p = document.createElement("p");
    p.className = "line";
    p.innerHTML =
      `<span class="ts">${fmtElapsed(t)}</span>` +
      `<span class="x"></span>`;
    p.querySelector(".x").textContent = text.trim();
    dom.transcript.appendChild(p);
    dom.transcript.scrollTop = dom.transcript.scrollHeight;

    updateTranscriptStat();
    refreshAskButton();
  }

  function refreshAskButton() {
    if (!dom.btnAsk) return;
    const enoughLines = state.transcriptLines.length >= MIN_LINES_TO_ASK;
    dom.btnAsk.disabled = !enoughLines || !!state.askTimer;
    dom.btnAsk.title = enoughLines
      ? "由 AI 從目前逐字稿產出 3–5 個追問"
      : `逐字稿至少要 ${MIN_LINES_TO_ASK} 行才能產出有意義的問題`;
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
    dom.transcript.innerHTML =
      '<p class="placeholder">按「錄音」開始即時轉錄。會請求麥克風權限,音訊僅在本機處理。</p>';
    dom.questions.innerHTML =
      '<p class="placeholder">按「產生問題」由 AI 從逐字稿產出 3–5 個追問。</p>';
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

  function renderQuestions(questions) {
    dom.questions.innerHTML = "";
    if (!questions || questions.length === 0) {
      dom.questions.innerHTML =
        '<p class="placeholder">這次沒有產出問題,逐字稿可能太短了。</p>';
      updateQuestionsStat(0);
      return;
    }
    questions.forEach((q, i) => {
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

      card.appendChild(num);
      card.appendChild(body);
      dom.questions.appendChild(card);
    });
    updateQuestionsStat(questions.length);
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

  function stopRecording({ keepTranscript = true } = {}) {
    state.isRecording = false;
    try { state.audioSource?.disconnect(); } catch (_) {}
    try {
      state.audioProc?.port.postMessage({ type: "flush" });
      state.audioProc?.disconnect();
    } catch (_) {}
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

    if (!keepTranscript) clearTranscript();
  }

  // ─── 生成問題 ────────────────────────────────────────────────────
  function startAskTimer() {
    state.askStartedAt = Date.now();
    const tick = () => {
      const e = Math.floor((Date.now() - state.askStartedAt) / 1000);
      dom.btnAsk.textContent = `思考中 ${fmtElapsed(e)}`;
      if (dom.questionsStat) dom.questionsStat.textContent = `思考中 ${fmtElapsed(e)}`;
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

  async function askQuestions() {
    if (state.askTimer) return; // 已在跑,別重複觸發
    const transcript = getFullTranscript();
    if (!transcript) {
      showError("還沒有逐字稿可以分析");
      return;
    }
    if (state.transcriptLines.length < MIN_LINES_TO_ASK) {
      showError(`逐字稿至少要 ${MIN_LINES_TO_ASK} 行才能產出有意義的問題`);
      return;
    }
    startAskTimer();
    refreshAskButton();
    dom.questions.innerHTML = '<p class="placeholder">AI 正在閱讀逐字稿,通常 5-15 秒…</p>';

    try {
      const resp = await fetch(`${API_BASE}/api/questions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          prior_summary: state.priorSummary,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      if (data.summary) state.priorSummary = data.summary;
      renderQuestions(data.questions);
    } catch (err) {
      console.error(err);
      showError(`生成問題失敗:${err.message || err}`);
      dom.questions.innerHTML = '<p class="placeholder">生成失敗,請重試。</p>';
      updateQuestionsStat(0);
    } finally {
      stopAskTimer();
      refreshAskButton();
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

  function buildMeetingFilename() {
    const d = new Date();
    const y = d.getFullYear();
    const mo = pad2(d.getMonth() + 1);
    const da = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const mm = pad2(d.getMinutes());
    return `meeting_${y}-${mo}-${da}_${hh}${mm}.md`;
  }

  // ─── 綁定 ────────────────────────────────────────────────────────
  dom.btnStart.addEventListener("click", startRecording);
  dom.btnStop.addEventListener("click", () => stopRecording({ keepTranscript: true }));
  dom.btnAsk.addEventListener("click", askQuestions);
  dom.btnClear.addEventListener("click", handleClearClick);
  dom.btnDownload.addEventListener("click", downloadTranscript);

  // 初始 UI 狀態
  setConn("offline", "待機");
  updateTranscriptStat();
  updateQuestionsStat(0);
  refreshAskButton();
})();
