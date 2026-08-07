#!/usr/bin/env python3
"""
前端版本號 bump 工具

與 check_frontend_versions.py 的分工：
  check_*  只檢查、不改動，跑在每個 PR 上當關卡
  bump_*   實際修改版本號

依 AGENTS.md「Frontend and PWA versioning」一節，index.html 的 ?v=N 與
sw.js 的 CACHE_NAME 由這支工具專責管理，其他任務中的 agent 一律不得
自行新增、修改或 bump 這些值——即使該任務本身就有改到前端檔案。

【為什麼版本號要收斂到這裡】

判斷「哪些檔案要一起 bump」需要理解 Cache API 的比對行為（查詢字串會
算進 cache key），不是看哪個檔案被改了就 bump 哪個。實際踩過的坑：
某次任務只更新了 style.css 一個版本號，造成 index.html 出現 31/30/30
不一致。

這支工具的設計是：
  - 遇到需要判斷的情況（有新檔案不在 APP_SHELL、動態 import 未登記）
    直接拒絕執行並說明原因，不自作主張
  - 執行前後都印出「改了什麼、為什麼」，滿足 AGENTS.md 要求的說明義務

真正機械化的只有「數字加一，兩個檔案同步」這件事——
那本來就沒有判斷空間，而且是最容易漏掉的部分。

解析規則（APP_SHELL、CACHE_NAME、動態 import、index.html 的 ?v=）
共用 .pipeline/frontend_version_rules.py，跟 check_frontend_versions.py
是同一份，避免兩支工具對同一份檔案有不同的解讀。

用法：
  python3 .pipeline/bump_versions.py --base main          # 檢查並執行
  python3 .pipeline/bump_versions.py --base main --dry-run # 只看會改什麼
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from frontend_version_rules import (
    parse_app_shell,
    parse_cache_name,
    parse_dynamic_imports,
    parse_index_local_assets,
    parse_index_versions,
    rewrite_app_shell_versions,
    rewrite_index_versions,
)

INDEX = Path("index.html")
SW = Path("sw.js")
SCRIPT = Path("script.js")


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8") if p.exists() else ""


def summary(md: str):
    """
    寫進 GitHub Actions 的執行摘要，會顯示在結果頁面最上方，
    不用展開步驟就看得到。

    這是刻意加的：原本失敗訊息只印在 log 裡，
    使用者得點進去、展開步驟才找得到原因，
    等於「擋住了但沒說為什麼」。
    本機執行時 GITHUB_STEP_SUMMARY 不存在，就只印到畫面上。
    """
    import os
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(md + "\n")


def git_changed_files(base: str) -> list:
    for args in (
        ["git", "diff", "--name-only", f"{base}...HEAD"],
        ["git", "diff", "--name-only", base],
    ):
        r = subprocess.run(args, capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip():
            return [f for f in r.stdout.strip().split("\n") if f]
    return []


def _managed_versions(html: str) -> set:
    """
    index.html 裡「受這支工具管理」的資源版本號。

    只認 src/href 上的 .js 與 .css（規則來自 frontend_version_rules），
    所以 manifest.json?v=N 不會被算進來——它在 sw.js 的 APP_SHELL 裡是
    不帶查詢字串的 ./manifest.json，本來就不跟這些共用版本號。
    """
    return {int(v) for v in parse_index_versions(html).values() if v.isdigit()}


def current_version(html: str) -> int:
    versions = _managed_versions(html)
    if len(versions) != 1:
        return -1 if not versions else -2
    return versions.pop()


def guard_needs_human_judgement(html, sw, script) -> list:
    """
    這些情況需要人判斷，工具不得自作主張。回傳阻擋原因清單。
    """
    blockers = []
    app_shell = parse_app_shell(sw)
    shell_files = {re.sub(r"\?.*$", "", e).lstrip("./") for e in app_shell}

    for asset in sorted(parse_index_local_assets(html)):
        if asset not in shell_files:
            blockers.append(
                f"{asset} 被 index.html 引用，但不在 APP_SHELL 清單裡。"
                f"要不要加、加了要不要帶 ?v=，需要你判斷。"
            )

    shell_raw = [e.lstrip("./") for e in app_shell]
    for path in sorted(parse_dynamic_imports(script)):
        if path not in shell_files:
            blockers.append(
                f"{path} 被 script.js 用 await import() 載入，但不在 APP_SHELL 裡。"
                f"漏了會在加到主畫面後壞掉，需要你確認要不要加。"
            )
            continue
        for entry in shell_raw:
            if entry.startswith(path) and "?v=" in entry:
                blockers.append(
                    f"{path} 在 APP_SHELL 裡帶了 ?v=，但動態 import 的路徑沒有查詢字串。"
                    f"Cache API 比對會失敗，請先手動移除這一項的 ?v=。"
                )
    return blockers


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="main")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    html, sw, script = read(INDEX), read(SW), read(SCRIPT)
    if not html or not sw:
        print("找不到 index.html 或 sw.js")
        return 1

    # ---------- 判斷是否需要 bump ----------
    app_shell = parse_app_shell(sw)
    shell_files = {
        f
        for f in (re.sub(r"\?.*$", "", e).lstrip("./") for e in app_shell)
        if f and not f.endswith("/")
    }
    changed = git_changed_files(args.base)
    touched = sorted(set(changed) & shell_files)
    sw_touched = "sw.js" in changed

    print(f"與 {args.base} 比較，本次變更 {len(changed)} 個檔案")
    if not touched and not sw_touched:
        print("其中沒有任何 APP_SHELL 內的檔案。")
        print("依 AGENTS.md，非前端任務不應變更版本號。不執行 bump。")
        summary(
            "## 不需要 bump\n\n"
            "本次變更沒有動到任何 Service Worker 會快取的檔案，"
            "使用者的瀏覽器不需要重新抓取資源。\n\n"
            f"變更的檔案：{', '.join(changed) or '（無）'}"
        )
        return 0

    print(f"其中屬於 APP_SHELL 的：{', '.join(touched) or '（僅 sw.js 本身）'}")
    print("→ 使用者的瀏覽器需要重新抓取這些資源，因此需要 bump。\n")

    # ---------- 需要人判斷的先擋下 ----------
    blockers = guard_needs_human_judgement(html, sw, script)
    if blockers:
        print("以下情況需要你自己判斷，工具不會替你決定：\n")
        for b in blockers:
            print(f"  - {b}")
        print("\n處理完再執行一次。未修改任何檔案。")
        summary(
            "## 需要你手動處理，版本號未更新\n\n"
            "以下情況需要判斷 Cache API 的行為，工具不替你決定：\n\n"
            + "\n".join(f"- {b}" for b in blockers)
            + "\n\n處理完之後再執行一次這個 workflow。"
            "\n\n**未修改任何檔案。**"
        )
        return 1

    # ---------- 計算新版本 ----------
    cur = current_version(html)
    if cur == -1:
        print("index.html 找不到任何 ?v= 版本號，無法判斷起始值")
        summary("## 執行失敗\n\n`index.html` 找不到任何 `?v=` 版本號，無法判斷起始值。")
        return 1
    if cur == -2:
        vs = sorted(_managed_versions(html))
        print(f"index.html 裡的 ?v= 版本號不一致：{vs}")
        print("請先手動統一成同一個數字，工具不猜你想用哪個。")
        summary(
            "## 需要你手動處理，版本號未更新\n\n"
            f"`index.html` 裡的 `?v=` 版本號不一致：{vs}\n\n"
            "請先手動統一成同一個數字。工具不猜你想用哪個。"
        )
        return 1

    new = cur + 1
    cache_name = parse_cache_name(sw)
    cm = re.search(r"^(.*?)(\d+)$", cache_name)
    if not cm:
        print(f"CACHE_NAME「{cache_name}」結尾不是數字，無法自動遞增")
        return 1
    new_cache = f"{cm.group(1)}{int(cm.group(2)) + 1}"

    print(f"?v=       {cur} → {new}")
    print(f"CACHE_NAME {cache_name} → {new_cache}")

    if args.dry_run:
        print("\n（dry-run，未修改任何檔案）")
        return 0

    # ---------- 實際修改 ----------
    INDEX.write_text(rewrite_index_versions(html, new), encoding="utf-8")

    sw_new = rewrite_app_shell_versions(sw, new)
    sw_new = sw_new.replace(f'"{cache_name}"', f'"{new_cache}"')
    SW.write_text(sw_new, encoding="utf-8")

    print("\n已更新 index.html 與 sw.js。")
    print("提醒：Service Worker 的實際更新行為仍需實機驗證，")
    print("把 App 完全關閉後重開（可能需要兩次），不要刪除主畫面捷徑——")
    print("刪除捷徑會清掉推播訂閱並在資料庫留下孤兒紀錄。")
    summary(
        "## 版本號已更新\n\n"
        f"| 項目 | 變更 |\n|---|---|\n"
        f"| `?v=` | {cur} → {new} |\n"
        f"| `CACHE_NAME` | `{cache_name}` → `{new_cache}` |\n\n"
        f"觸發原因：本次變更了 APP_SHELL 內的檔案"
        f"（{', '.join(touched) or 'sw.js'}）\n\n"
        "### 合併後要做的事\n\n"
        "把 App **完全關閉**後重開（可能需要兩次），"
        "讓 Service Worker 接管新版本。\n\n"
        "**不要刪除主畫面捷徑**——那會清掉推播訂閱，"
        "並在資料庫留下不會被撤銷的孤兒紀錄。"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
