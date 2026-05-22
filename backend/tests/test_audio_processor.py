"""AudioProcessor 單元測試：VAD 狀態機、WAV 封裝。"""

from __future__ import annotations

import io
import struct
import time
import wave

import pytest

from app.audio_processor import (
    BYTES_PER_SAMPLE,
    CHANNELS,
    SAMPLE_RATE,
    AudioProcessor,
)


def _silence_frame(n_samples: int = 480) -> bytes:
    """產生全 0 的 PCM16 幀（30ms @ 16kHz = 480 samples）。"""
    return struct.pack(f"<{n_samples}h", *([0] * n_samples))


def _loud_frame(n_samples: int = 480, amplitude: int = 5000) -> bytes:
    """產生高振幅 PCM16 幀（RMS 遠高於預設門檻 300）。"""
    return struct.pack(f"<{n_samples}h", *([amplitude] * n_samples))


@pytest.mark.unit
class TestSpeechDetection:
    def test_loud_frame_is_detected_as_speech(self) -> None:
        assert AudioProcessor._has_speech(_loud_frame(), threshold=300.0) is True

    def test_silent_frame_is_not_speech(self) -> None:
        assert AudioProcessor._has_speech(_silence_frame(), threshold=300.0) is False

    def test_empty_frame_is_not_speech(self) -> None:
        assert AudioProcessor._has_speech(b"", threshold=300.0) is False

    def test_low_amplitude_below_threshold(self) -> None:
        # amplitude=100 RMS=100，低於 300 門檻
        low = struct.pack("<480h", *([100] * 480))
        assert AudioProcessor._has_speech(low, threshold=300.0) is False


@pytest.mark.unit
class TestVADStateMachine:
    def test_should_not_process_when_no_frames(self) -> None:
        p = AudioProcessor()
        assert p.should_process() is False

    def test_should_not_process_if_never_spoke(self) -> None:
        p = AudioProcessor()
        for _ in range(10):
            p.add_frame(_silence_frame())
        assert p.should_process() is False

    def test_should_not_process_during_active_speech(self) -> None:
        p = AudioProcessor()
        p.add_frame(_loud_frame())
        assert p.should_process() is False  # 還在說話，沒進入靜音

    def test_should_process_after_silence_timeout(self) -> None:
        # 極短 timeout 以免測試拖太久
        p = AudioProcessor(silence_timeout_s=0.05, rms_threshold=300.0)
        p.add_frame(_loud_frame())      # 進入 speaking 狀態
        p.add_frame(_silence_frame())   # 開始計時靜音
        time.sleep(0.1)                 # 超過 timeout
        p.add_frame(_silence_frame())   # 任一幀觸發 should_process 重新檢查
        assert p.should_process() is True

    def test_speech_resets_silence_timer(self) -> None:
        p = AudioProcessor(silence_timeout_s=0.05, rms_threshold=300.0)
        p.add_frame(_loud_frame())
        p.add_frame(_silence_frame())
        time.sleep(0.1)
        # 再講話 → 靜音計時器應被重置
        p.add_frame(_loud_frame())
        assert p.should_process() is False

    def test_clear_resets_state(self) -> None:
        p = AudioProcessor(silence_timeout_s=0.05, rms_threshold=300.0)
        p.add_frame(_loud_frame())
        p.add_frame(_silence_frame())
        time.sleep(0.1)
        p.clear()
        assert p.should_process() is False
        assert p.get_wav_bytes() is None


@pytest.mark.unit
class TestWavSerialization:
    def test_get_wav_bytes_none_when_empty(self) -> None:
        p = AudioProcessor()
        assert p.get_wav_bytes() is None

    def test_wav_header_metadata_is_correct(self) -> None:
        p = AudioProcessor()
        for _ in range(5):
            p.add_frame(_loud_frame())

        wav_bytes = p.get_wav_bytes()
        assert wav_bytes is not None

        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            assert wf.getnchannels() == CHANNELS
            assert wf.getsampwidth() == BYTES_PER_SAMPLE
            assert wf.getframerate() == SAMPLE_RATE

    def test_get_wav_bytes_is_pure_read(self) -> None:
        """get_wav_bytes 不應修改內部狀態（可以安全重複呼叫）。"""
        p = AudioProcessor()
        p.add_frame(_loud_frame())
        first = p.get_wav_bytes()
        second = p.get_wav_bytes()
        assert first == second
