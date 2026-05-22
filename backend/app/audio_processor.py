from __future__ import annotations

import io
import struct
import wave
from datetime import datetime

from app.config import FRONTEND_VAD_RMS_THRESHOLD, FRONTEND_VAD_SILENCE_TIMEOUT_S

SAMPLE_RATE: int = 16000
CHANNELS: int = 1
BYTES_PER_SAMPLE: int = 2
SAMPLES_PER_FRAME: int = int(SAMPLE_RATE * 0.030)

_WAV_MIN_BYTES: int = 1000


class AudioProcessor:
    """Raw PCM16 LE 音訊幀收集器，偵測靜音後觸發轉錄。

    使用方式：
        processor = AudioProcessor()
        processor.add_frame(pcm_bytes)
        if processor.should_process():
            wav = processor.get_wav_bytes()
            processor.clear()
    """

    def __init__(
        self,
        silence_timeout_s: float = FRONTEND_VAD_SILENCE_TIMEOUT_S,
        rms_threshold: float = FRONTEND_VAD_RMS_THRESHOLD,
    ) -> None:
        self._silence_timeout_s = silence_timeout_s
        self._rms_threshold = rms_threshold
        self.reset()

    def reset(self) -> None:
        """重置所有狀態（等同 clear，但也重置 speaking flag）。"""
        self._frames: list[bytes] = []
        self._is_speaking: bool = False
        self._silence_start: datetime | None = None

    def add_frame(self, frame: bytes) -> None:
        """加入一個 PCM 幀並更新語音狀態機。"""
        self._frames.append(frame)
        is_speech = self._has_speech(frame, self._rms_threshold)
        if is_speech:
            self._is_speaking = True
            self._silence_start = None
        elif self._is_speaking and self._silence_start is None:
            self._silence_start = datetime.now()

    def should_process(self) -> bool:
        """回傳是否應觸發轉錄（偵測到語音後靜音超過 timeout）。"""
        if not self._is_speaking or not self._frames or self._silence_start is None:
            return False
        elapsed = (datetime.now() - self._silence_start).total_seconds()
        return elapsed >= self._silence_timeout_s

    def get_wav_bytes(self) -> bytes | None:
        """將已收集的幀封裝為 WAV bytes，不修改內部狀態（pure read）。"""
        if not self._frames:
            return None
        audio_data = b"".join(self._frames)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(CHANNELS)
            wf.setsampwidth(BYTES_PER_SAMPLE)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(audio_data)
        return buf.getvalue()

    def clear(self) -> None:
        """清除已處理的幀並重置狀態（呼叫 get_wav_bytes 後執行）。"""
        self._frames = []
        self._silence_start = None
        self._is_speaking = False

    @staticmethod
    def _has_speech(frame: bytes, threshold: float) -> bool:
        """以 RMS 能量判斷幀內是否含語音。"""
        n = len(frame) // 2
        if n == 0:
            return False
        samples = struct.unpack_from(f"<{n}h", frame)
        rms = (sum(s * s for s in samples) / n) ** 0.5
        return rms > threshold
