"""pytest 共用 fixture 與路徑設定。

確保 tests 目錄下的 import（例如 `from app.xxx import ...`）能正確解析到 api/app/。
"""

from __future__ import annotations

import sys
from pathlib import Path

# 將 api/ 加入 sys.path，讓 `from app.xxx import ...` 能解析
_API_DIR = Path(__file__).resolve().parent.parent
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))
