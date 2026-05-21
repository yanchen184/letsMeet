"""Google Meet VTT 逐字稿 AI 自動摘要工具。

掃描 input/ 資料夾中的 .vtt 檔案，透過 Gemini 1.5 Pro 生成會議摘要，
輸出 .md 到 output/，處理完的 .vtt 移到 input/processed/。
"""

import logging
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

from processor import generate_summary, process_vtt

# 專案根目錄
BASE_DIR = Path(__file__).resolve().parent
INPUT_DIR = BASE_DIR / "input"
PROCESSED_DIR = INPUT_DIR / "processed"
OUTPUT_DIR = BASE_DIR / "output"
LOG_DIR = BASE_DIR / "logs"


def setup_logging() -> None:
    """設定 logging，同時輸出到檔案與 console。"""
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    log_file = LOG_DIR / f"process_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
        handlers=[
            logging.FileHandler(log_file, encoding="utf-8"),
            logging.StreamHandler(sys.stdout),
        ],
    )


def get_api_key() -> str:
    """從環境變數或 .env 取得 GEMINI_API_KEY。"""
    load_dotenv(BASE_DIR / ".env")
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise EnvironmentError(
            "未設定 GEMINI_API_KEY。請在環境變數或 .env 檔案中設定。"
        )
    return api_key


def ensure_directories() -> None:
    """確保所有必要資料夾存在。"""
    for d in (INPUT_DIR, PROCESSED_DIR, OUTPUT_DIR, LOG_DIR):
        d.mkdir(parents=True, exist_ok=True)


def main() -> None:
    """批次處理 input/ 下所有 .vtt 檔案。"""
    setup_logging()
    logger = logging.getLogger(__name__)

    ensure_directories()

    logger.info("=== VTT 會議摘要工具啟動 ===")

    try:
        api_key = get_api_key()
    except EnvironmentError as e:
        logger.error(str(e))
        sys.exit(1)

    vtt_files = sorted(INPUT_DIR.glob("*.vtt"))

    if not vtt_files:
        logger.info("input/ 資料夾中沒有 .vtt 檔案，結束。")
        return

    logger.info("找到 %d 個 .vtt 檔案待處理", len(vtt_files))

    success_count = 0
    fail_count = 0

    for idx, vtt_path in enumerate(vtt_files, start=1):
        logger.info("[%d/%d] 處理中: %s", idx, len(vtt_files), vtt_path.name)

        try:
            # 解析 VTT
            transcript = process_vtt(str(vtt_path))
            if not transcript.strip():
                logger.warning("檔案 %s 解析後無對話內容，跳過。", vtt_path.name)
                fail_count += 1
                continue

            # 生成摘要
            summary = generate_summary(transcript, api_key)

            # 輸出 .md
            today = datetime.now().strftime("%Y%m%d")
            stem = vtt_path.stem
            output_name = f"{stem}_摘要_{today}.md"
            output_path = OUTPUT_DIR / output_name
            output_path.write_text(summary, encoding="utf-8")
            logger.info("摘要已輸出: %s", output_path.name)

            # 移動已處理的 .vtt
            dest = PROCESSED_DIR / vtt_path.name
            shutil.move(str(vtt_path), str(dest))
            logger.info("已移動至 processed/: %s", vtt_path.name)

            success_count += 1

        except FileNotFoundError as e:
            logger.error("檔案不存在: %s", e)
            fail_count += 1
        except ValueError as e:
            logger.error("格式錯誤: %s", e)
            fail_count += 1
        except RuntimeError as e:
            logger.error("API 錯誤: %s", e)
            fail_count += 1
        except Exception as e:
            logger.error("未預期錯誤處理 %s: %s", vtt_path.name, e, exc_info=True)
            fail_count += 1

    logger.info(
        "=== 處理完成：成功 %d，失敗 %d，共 %d 個檔案 ===",
        success_count,
        fail_count,
        len(vtt_files),
    )


if __name__ == "__main__":
    main()
