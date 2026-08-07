#!/usr/bin/env python3
"""
前端版本一致性檢查器

這支程式**不會**幫你改版本號。依 AGENTS.md 的規定，
版本號由 .pipeline/bump_versions.py 專責管理，
其他任務一律不得自行新增、修改或 bump。

它做的是另一件事：檢查你改完之後有沒有漏掉。
漏了就讓 CI 變紅，擋在合併之前。

解析規則（APP_SHELL、CACHE_NAME、動態 import、index.html 的 ?v=）
共用 .pipeline/frontend_version_rules.py，跟 bump_versions.py 是同一份，
避免兩支工具對同一份檔案有不同的解讀。

檢查項目：
  1. index.html 與 sw.js 的 ?v= 版本號是否一致
  2. APP_SHELL 裡的檔案有變動時，CACHE_NAME 是否也改了
  3. index.html 引用的本地 js/css 是否都在 APP_SHELL 裡
  4. script.js 動態 import 的檔案是否都在 APP_SHELL 裡
  5. index.html 帶 ?v= 但非 .js/.css 的資源，是否與 APP_SHELL 對不上
  6. APP_SHELL 裡列的檔案是否真的存在

第 4 項是踩過坑才加的：Task02 新增的 scripts/todo-query-filters.js
是用 await import() 載入的，漏加進 APP_SHELL 的話，
一般瀏覽器正常、加到主畫面才會壞，實機才測得出來。

用法：
  python3 .pipeline/check_frontend_versions.py            # 檢查全部
  python3 .pipeline/check_frontend_versions.py --base main # 同時檢查是否該 bump
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
    parse_index_unmanaged_versions,
    parse_index_versions,
)

INDEX = Path("index.html")
SW = Path("sw.js")
SCRIPT = Path("script.js")


class Result:
    def __init__(self):
        self.errors = []
        self.warnings = []
        self.notes = []

    def error(self, msg):
        self.errors.append(msg)

    def warn(self, msg):
        self.warnings.append(msg)

    def note(self, msg):
        self.notes.append(msg)


def read(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")


def git_changed_files(base: str) -> list:
    r = subprocess.run(
        ["git", "diff", "--name-only", f"{base}...HEAD"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        # 可能是還沒 commit，退回比較索引
        r = subprocess.run(
            ["git", "diff", "--cached", "--name-only", base],
            capture_output=True, text=True,
        )
    return [f for f in r.stdout.strip().split("\n") if f]


def git_file_at(base: str, path: str) -> str:
    r = subprocess.run(
        ["git", "show", f"{base}:{path}"],
        capture_output=True, text=True,
    )
    return r.stdout if r.returncode == 0 else ""


def check_version_consistency(res: Result, index_versions: dict, app_shell: list):
    """index.html 與 sw.js 的 ?v= 必須一致"""
    shell_versions = {}
    for entry in app_shell:
        m = re.match(r'\.?/?([^?]+)\?v=(.+)$', entry)
        if m:
            shell_versions[m.group(1)] = m.group(2)

    for filename, ver in index_versions.items():
        if filename not in shell_versions:
            res.warn(
                f"{filename} 在 index.html 帶了 ?v={ver}，"
                f"但 sw.js 的 APP_SHELL 裡沒有對應的 ?v= 項目"
            )
            continue
        if shell_versions[filename] != ver:
            res.error(
                f"{filename} 版本號不一致："
                f"index.html 是 ?v={ver}，sw.js 是 ?v={shell_versions[filename]}。"
                f"兩邊必須相同，否則 Service Worker 快取的會是另一份檔案"
            )

    for filename, ver in shell_versions.items():
        if filename not in index_versions:
            res.warn(
                f"{filename} 在 sw.js 帶了 ?v={ver}，但 index.html 沒有對應引用"
            )


def check_index_assets_in_shell(res: Result, index_assets: set, app_shell: list):
    """index.html 引用的本地 js/css 應該都在 APP_SHELL 裡"""
    shell_files = {re.sub(r'\?.*$', '', e).lstrip("./") for e in app_shell}
    for asset in sorted(index_assets):
        if asset not in shell_files:
            res.error(
                f"{asset} 被 index.html 引用，但不在 sw.js 的 APP_SHELL 清單裡。"
                f"離線或從主畫面開啟時會抓不到這個檔案"
            )


def check_dynamic_imports_in_shell(res: Result, dyn: set, app_shell: list):
    """動態 import 的檔案必須在 APP_SHELL，而且不能帶 ?v="""
    shell_raw = [e.lstrip("./") for e in app_shell]
    shell_files = {re.sub(r'\?.*$', '', e) for e in shell_raw}

    for path in sorted(dyn):
        if path not in shell_files:
            res.error(
                f"{path} 被 script.js 用 await import() 動態載入，"
                f"但不在 APP_SHELL 清單裡。"
                f"這種問題桌面瀏覽器測不出來，只有加到主畫面才會壞"
            )
            continue
        for entry in shell_raw:
            if entry.startswith(path) and "?v=" in entry:
                res.error(
                    f"{path} 在 APP_SHELL 裡帶了 ?v=，但動態 import 的路徑沒有查詢字串。"
                    f"Cache API 比對時會把查詢字串算進 key，兩者對不上會導致快取未命中。"
                    f"請移除這一項的 ?v="
                )


def check_unmanaged_versioned_assets(res: Result, unmanaged: dict, app_shell: list):
    """
    index.html 帶了 ?v= 但不是 .js/.css 的資源（例如 manifest.json），
    若在 APP_SHELL 裡是不帶查詢字串的形式，兩者永遠對不上。

    形狀跟上面「動態 import 不可帶 ?v=」那條相同，只是方向相反：
    那條是 APP_SHELL 帶了、載入端沒帶；這條是引用端帶了、APP_SHELL 沒帶。
    """
    shell_raw = [e.lstrip("./") for e in app_shell]

    for path, ver in sorted(unmanaged.items()):
        # 完全相符代表 APP_SHELL 那一項沒有查詢字串
        if path in shell_raw:
            res.error(
                f"{path} 在 index.html 帶了 ?v={ver}，但 sw.js 的 APP_SHELL 裡是"
                f"不帶查詢字串的 {path}。"
                f"Cache API 比對時會把查詢字串算進 key，兩者對不上，"
                f"這個資源永遠不會命中快取——線上時每次都得重新下載，"
                f"離線時則直接抓不到。"
                f"正確做法是移除 index.html 這個 ?v={ver}："
                f"它不在版本號管理範圍內，內容更新改由 CACHE_NAME 遞增觸發"
                f"（install 階段的 cache: \"reload\" 會略過 HTTP 快取重抓）"
            )


def check_shell_files_exist(res: Result, app_shell: list):
    for entry in app_shell:
        path = re.sub(r'\?.*$', '', entry).lstrip("./")
        if not path or path.endswith("/"):
            continue
        if not Path(path).exists():
            res.error(f"APP_SHELL 列了 {path}，但這個檔案不存在")


def check_bump_needed(res: Result, base: str, app_shell: list, cache_name: str):
    """APP_SHELL 裡的檔案有變動時，CACHE_NAME 必須也改了"""
    changed = git_changed_files(base)
    if not changed:
        res.note("沒有偵測到與 base 的差異，略過 bump 檢查")
        return

    shell_files = {re.sub(r'\?.*$', '', e).lstrip("./") for e in app_shell}
    shell_files = {f for f in shell_files if f and not f.endswith("/")}

    touched = sorted(set(changed) & shell_files)
    sw_touched = "sw.js" in changed

    if not touched and not sw_touched:
        res.note("本次未變動任何 APP_SHELL 內的檔案，不需要 bump CACHE_NAME")
        return

    old_sw = git_file_at(base, "sw.js")
    old_cache_name = parse_cache_name(old_sw)

    if old_cache_name and old_cache_name == cache_name:
        res.error(
            f"本次變動了 APP_SHELL 內的檔案（{', '.join(touched) or 'sw.js'}），"
            f"但 CACHE_NAME 仍然是 {cache_name}，沒有 bump。"
            f"使用者的瀏覽器會繼續使用舊快取，改動不會生效"
        )
    else:
        res.note(
            f"CACHE_NAME 已從 {old_cache_name or '（無）'} 改為 {cache_name}，"
            f"對應變動檔案：{', '.join(touched) or 'sw.js'}"
        )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="", help="比較用的基準分支，例如 main")
    args = ap.parse_args()

    res = Result()

    html = read(INDEX)
    sw = read(SW)
    script = read(SCRIPT)

    if not html or not sw:
        print("找不到 index.html 或 sw.js，略過檢查")
        return 0

    index_versions = parse_index_versions(html)
    index_unmanaged = parse_index_unmanaged_versions(html)
    index_assets = parse_index_local_assets(html)
    app_shell = parse_app_shell(sw)
    cache_name = parse_cache_name(sw)
    dyn = parse_dynamic_imports(script)

    print(f"CACHE_NAME：{cache_name}")
    print(f"APP_SHELL 項目數：{len(app_shell)}")
    print(f"index.html 帶版本號的資源：{len(index_versions)}")
    print(f"script.js 動態 import：{len(dyn) or '無'}")
    print()

    check_version_consistency(res, index_versions, app_shell)
    check_index_assets_in_shell(res, index_assets, app_shell)
    check_dynamic_imports_in_shell(res, dyn, app_shell)
    check_unmanaged_versioned_assets(res, index_unmanaged, app_shell)
    check_shell_files_exist(res, app_shell)
    if args.base:
        check_bump_needed(res, args.base, app_shell, cache_name)

    for n in res.notes:
        print(f"  {n}")
    for w in res.warnings:
        print(f"[提醒] {w}")
    for e in res.errors:
        print(f"[錯誤] {e}")

    print()
    if res.errors:
        print(f"檢查未通過：{len(res.errors)} 個錯誤")
        print("請自行判斷並修正後再合併。這支程式不會替你改動任何檔案。")
        return 1

    print("檢查通過")
    return 0


if __name__ == "__main__":
    sys.exit(main())
