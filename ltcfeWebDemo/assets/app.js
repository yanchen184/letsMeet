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
  };

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

  function showError(msg) {
    let banner = document.querySelector(".error-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "error-banner";
      document.querySelector("main").prepend(banner);
    }
    banner.textContent = msg;
    setTimeout(() => banner.remove(), 6000);
  }

  function fmtElapsed(secs) {
    const m = String(Math.floor(secs / 60)).padStart(2, "0");
    const s = String(secs % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  function startElapsed() {
    state.startEpoch = Date.now();
    state.elapsedTimer = setInterval(() => {
      const e = Math.floor((Date.now() - state.startEpoch) / 1000);
      dom.elapsed.textContent = fmtElapsed(e);
    }, 1000);
  }

  function stopElapsed() {
    if (state.elapsedTimer) {
      clearInterval(state.elapsedTimer);
      state.elapsedTimer = null;
    }
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
      `<span class="t">${fmtElapsed(t)}</span>` +
      `<span class="x"></span>`;
    p.querySelector(".x").textContent = text.trim();
    dom.transcript.appendChild(p);
    dom.transcript.scrollTop = dom.transcript.scrollHeight;

    dom.btnAsk.disabled = false;
  }

  function clearTranscript() {
    state.transcriptLines = [];
    state.priorSummary = null;
    dom.transcript.innerHTML =
      '<p class="placeholder">按「開始錄音」開始即時轉錄。</p>';
    dom.btnAsk.disabled = true;
  }

  function getFullTranscript() {
    return state.transcriptLines.map((l) => l.text).join(" ");
  }

  function renderQuestions(questions) {
    dom.questions.innerHTML = "";
    if (!questions || questions.length === 0) {
      dom.questions.innerHTML =
        '<p class="placeholder">這次沒有產出問題，逐字稿可能太短了。</p>';
      return;
    }
    questions.forEach((q, i) => {
      const card = document.createElement("div");
      card.className = "question-card";
      const qp = document.createElement("p");
      qp.className = "q";
      qp.textContent = `Q${i + 1}. ${q.q}`;
      const wp = document.createElement("p");
      wp.className = "why";
      wp.textContent = q.why ? `why: ${q.why}` : "";
      card.appendChild(qp);
      if (q.why) card.appendChild(wp);
      dom.questions.appendChild(card);
    });
  }

  // ─── WebSocket / 錄音 ────────────────────────────────────────────
  async function startRecording() {
    if (state.isRecording) return;
    setConn("connecting", "連線中...");
    dom.btnStart.disabled = true;

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
        setConn("online", "錄音中");
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
        showError("WebSocket 錯誤，請檢查後端服務是否啟動");
      };
      state.ws.onclose = () => {
        if (state.isRecording) {
          showError("連線中斷，目前的逐字稿已保留；按「開始錄音」可重新連線續錄");
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
      if (state.transcriptLines.length === 0) {
        startElapsed();
      }
    } catch (err) {
      console.error(err);
      showError(`無法啟動錄音：${err.message || err}`);
      setConn("offline", "未連線");
      dom.btnStart.disabled = false;
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
    setConn("offline", "已停止");
    dom.btnStart.disabled = false;
    dom.btnStop.disabled = true;

    if (!keepTranscript) clearTranscript();
  }

  // ─── 生成問題 ────────────────────────────────────────────────────
  async function askQuestions() {
    const transcript = getFullTranscript();
    if (!transcript) {
      showError("還沒有逐字稿可以分析");
      return;
    }
    dom.btnAsk.disabled = true;
    dom.questions.innerHTML = '<p class="placeholder">AI 生成中...</p>';

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
      showError(`生成問題失敗：${err.message || err}`);
      dom.questions.innerHTML = '<p class="placeholder">生成失敗，請重試。</p>';
    } finally {
      dom.btnAsk.disabled = false;
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
    a.download = `meeting_${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── 綁定 ────────────────────────────────────────────────────────
  dom.btnStart.addEventListener("click", startRecording);
  dom.btnStop.addEventListener("click", () => stopRecording({ keepTranscript: true }));
  dom.btnAsk.addEventListener("click", askQuestions);
  dom.btnClear.addEventListener("click", clearTranscript);
  dom.btnDownload.addEventListener("click", downloadTranscript);

  // 初始 UI 狀態
  setConn("offline", "未連線");
})();
