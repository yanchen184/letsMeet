"""VTT 解析與 Gemini API 摘要生成模組。"""

import logging
import os
import re
from pathlib import Path

from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

SYSTEM_INSTRUCTION = """你是一位嚴謹的會議紀錄秘書。
任務：將逐字稿整理成結構化的紀錄，僅限於稿中提及的內容。
原則：
1. 嚴禁補腦：不准加入 AI 自行推論或臆測。
2. 保持專業名詞：保留 K8s, Redis, SDS, SPEC, ARS 等技術關鍵字。
3. 誠實標註：若語意模糊或提及「再看看、不確定」，請標註 [待確認]。
4. 排除雜訊：過濾寒暄與閒聊。

輸出格式：
## 📌 核心決議
## 🚀 行動清單 (負責人/內容/期限)
## ⚠️ 待解決/潛在風險"""


def process_vtt(file_path: str) -> str:
    """解析 VTT 檔案，回傳純文字對話。

    格式：`說話者: 內容`，每行一句。
    支援 <v> tag 格式與純文字格式。

    Args:
        file_path: VTT 檔案的絕對路徑。

    Returns:
        解析後的純文字對話字串。

    Raises:
        FileNotFoundError: 檔案不存在。
        ValueError: 檔案格式不正確。
    """
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"VTT 檔案不存在: {file_path}")

    content = path.read_text(encoding="utf-8")

    if not content.strip().startswith("WEBVTT"):
        raise ValueError(f"不是有效的 VTT 格式: {file_path}")

    # 時間軸 pattern: 00:00:01.000 --> 00:00:04.000
    timestamp_pattern = re.compile(r"\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}")
    # <v 說話者>內容</v> pattern
    voice_tag_pattern = re.compile(r"<v\s+([^>]+)>(.+?)</v>")

    lines = content.split("\n")
    dialogues: list[str] = []
    current_speaker = "未知"

    for line in lines:
        stripped = line.strip()

        # 跳過空行、WEBVTT header、時間軸、序號
        if not stripped:
            continue
        if stripped == "WEBVTT":
            continue
        if timestamp_pattern.match(stripped):
            continue
        if stripped.isdigit():
            continue
        # 跳過 NOTE 區塊標記
        if stripped.startswith("NOTE"):
            continue
        # 跳過 Style 區塊
        if stripped.startswith("STYLE") or stripped.startswith("::cue"):
            continue

        # 處理 <v> tag 格式
        voice_match = voice_tag_pattern.search(stripped)
        if voice_match:
            speaker = voice_match.group(1).strip()
            text = voice_match.group(2).strip()
            if text:
                dialogues.append(f"{speaker}: {text}")
            continue

        # 純文字格式（沒有 <v> tag）
        # 檢查是否是 "說話者: 內容" 格式
        colon_match = re.match(r"^([^:：]+)[：:](.+)$", stripped)
        if colon_match:
            speaker = colon_match.group(1).strip()
            text = colon_match.group(2).strip()
            if text:
                current_speaker = speaker
                dialogues.append(f"{speaker}: {text}")
            continue

        # 純文字，歸屬上一位說話者
        if stripped:
            dialogues.append(f"{current_speaker}: {stripped}")

    result = "\n".join(dialogues)
    logger.info("解析 VTT 完成: %s，共 %d 句對話", path.name, len(dialogues))
    return result


def generate_summary(transcript: str, api_key: str) -> str:
    """呼叫 Gemini 1.5 Pro 生成會議摘要。

    Args:
        transcript: 純文字對話內容。
        api_key: Gemini API Key。

    Returns:
        會議摘要 Markdown 字串。

    Raises:
        RuntimeError: API 呼叫失敗。
    """
    client = genai.Client(api_key=api_key)

    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=transcript,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_INSTRUCTION,
                temperature=0,
                top_p=0.95,
            ),
        )
        summary = response.text
        logger.info("Gemini 摘要生成成功，長度: %d 字元", len(summary))
        return summary
    except Exception as e:
        logger.error("Gemini API 呼叫失敗: %s", e)
        raise RuntimeError(f"Gemini API 呼叫失敗: {e}") from e
