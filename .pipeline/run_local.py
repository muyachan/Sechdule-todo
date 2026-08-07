#!/usr/bin/env python3
"""
本機版自動協作管線

跟 GitHub Actions 版跑的是同一套邏輯（共用 .pipeline/ 底下的模組），
差別只在：
  - 規格從本機檔案讀取，不用開 Issue
  - 輸出即時顯示在終端機，不用去 Actions 頁面翻 log
  - 建立 PR 前會停下來讓你確認

用法：
    python .pipeline/run_local.py 規格.md

前置需求（各裝一次就好）：
    1. Python 3.10+
    2. git（應該已經有了）
    3. GitHub CLI：https://cli.github.com/  裝完執行 gh auth login
    4. Codex CLI：npm install -g @openai/codex
    5. pip install requests python-docx
    6. 在 repo 根目錄建立 .env 檔案（內容見下方），並確認 .gitignore 有排除它

.env 檔案內容：
    ANTHROPIC_API_KEY=sk-ant-...
    OPENAI_API_KEY=sk-...
"""

import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# ---------------------------------------------------------------------------
# 終端機輸出的小工具
# ---------------------------------------------------------------------------

class C:
    """ANSI 色碼。Windows 10 之後的終端機都支援。"""
    DIM = "\033[2m"
    BOLD = "\033[1m"
    GREEN = "\033[32m"
    RED = "\033[31m"
    YELLOW = "\033[33m"
    CYAN = "\033[36m"
    OFF = "\033[0m"


def title(text: str):
    print(f"\n{C.BOLD}{C.CYAN}{'─' * 60}{C.OFF}")
    print(f"{C.BOLD}{C.CYAN}  {text}{C.OFF}")
    print(f"{C.BOLD}{C.CYAN}{'─' * 60}{C.OFF}")


def ok(text: str):
    print(f"  {C.GREEN}✓{C.OFF} {text}")


def fail(text: str):
    print(f"  {C.RED}✗{C.OFF} {text}")


def warn(text: str):
    print(f"  {C.YELLOW}!{C.OFF} {text}")


def dim(text: str):
    print(f"  {C.DIM}{text}{C.OFF}")


def ask(question: str) -> bool:
    ans = input(f"\n{C.BOLD}{question}{C.OFF} [y/N] ").strip().lower()
    return ans in ("y", "yes")


# ---------------------------------------------------------------------------
# 前置檢查
# ---------------------------------------------------------------------------

def sh(cmd: list, check=False) -> subprocess.CompletedProcess:
    """
    執行外部指令。找不到該指令時不拋例外，
    改回傳 returncode=127（Unix 慣例的 command not found），
    讓呼叫端可以統一用 returncode 判斷，錯誤訊息也比較好懂。

    cmd[0] 先經過 shutil.which() 解析：Windows 上像 codex 這種
    npm 全域安裝的指令，實際檔案是 codex.cmd（沒有 codex.exe），
    subprocess 在 shell=False 時底層呼叫 CreateProcess，
    只會自動補 .exe、不會查 PATHEXT，直接傳 "codex" 會找不到。
    shutil.which() 自己會照 PATHEXT 找，在 Linux/macOS 上行為不變。

    輸出用明確的 encoding="utf-8"，不用 text=True 的預設值——
    text=True 沒指定 encoding 時會退回系統 locale（例如日文 Windows
    是 cp932），但 git/gh/codex 一律輸出 UTF-8，兩者對不上會直接
    UnicodeDecodeError。errors="replace" 是保險，寧可個別字元被替換，
    也不要整個 stage 因為一段解不開的位元組而崩潰。
    """
    resolved = [shutil.which(cmd[0]) or cmd[0], *cmd[1:]]
    try:
        return subprocess.run(
            resolved,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            check=check,
        )
    except FileNotFoundError:
        return subprocess.CompletedProcess(cmd, 127, "", f"找不到指令：{cmd[0]}")


def load_env():
    """
    讀取 repo 根目錄的 .env。刻意不用第三方套件，
    少一個相依，也讓內容一目了然。
    """
    env_path = Path(".env")
    if not env_path.exists():
        fail(".env 檔案不存在")
        dim("請在 repo 根目錄建立 .env，內容：")
        dim("  ANTHROPIC_API_KEY=sk-ant-...")
        dim("  OPENAI_API_KEY=sk-...")
        dim("並確認 .gitignore 有排除 .env（絕對不能進 repo）")
        return False

    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ[k.strip()] = v.strip().strip('"').strip("'")
    return True


def preflight() -> bool:
    title("前置檢查")
    passed = True

    # .env 與金鑰
    if not load_env():
        return False
    for key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
        if os.environ.get(key):
            ok(f"{key} 已載入")
        else:
            fail(f"{key} 在 .env 裡找不到")
            passed = False

    # .gitignore 要排除 .env，否則金鑰可能被 commit
    gitignore = Path(".gitignore")
    if gitignore.exists() and ".env" in gitignore.read_text(encoding="utf-8"):
        ok(".gitignore 已排除 .env")
    else:
        fail(".gitignore 沒有排除 .env，金鑰有可能被 commit 進 repo")
        dim("請在 .gitignore 加一行：.env")
        passed = False

    # 外部工具
    for cmd, name, hint in (
        (["git", "--version"], "git", ""),
        (["gh", "--version"], "GitHub CLI", "https://cli.github.com/"),
        (["codex", "--version"], "Codex CLI", "npm install -g @openai/codex"),
    ):
        r = sh(cmd)
        if r.returncode == 0:
            ok(f"{name} 可用")
        else:
            fail(f"找不到 {name}")
            if hint:
                dim(f"安裝方式：{hint}")
            passed = False

    # 工作目錄要乾淨，否則 Codex 的變更會跟你自己改的混在一起
    r = sh(["git", "status", "--porcelain"])
    if r.stdout.strip():
        fail("工作目錄有未提交的變更")
        dim("Codex 的產出會跟這些混在一起，無法分辨。請先 commit 或 stash：")
        for line in r.stdout.strip().splitlines()[:10]:
            dim(f"  {line}")
        passed = False
    else:
        ok("工作目錄乾淨")

    # 提醒目前分支
    branch = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()
    if branch == "main":
        ok("目前在 main 分支")
    else:
        warn(f"目前在 {branch} 分支，不是 main。新分支會從這裡長出來")

    return passed


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    spec_path = Path(sys.argv[1])
    if not spec_path.exists():
        fail(f"找不到規格檔案：{spec_path}")
        return 1

    if not preflight():
        print(f"\n{C.RED}前置檢查未通過，已中止。修正後再執行一次。{C.OFF}")
        return 1

    spec = spec_path.read_text(encoding="utf-8")
    task_title = spec_path.stem
    stamp = datetime.now().strftime("%m%d-%H%M")
    branch = f"auto/{spec_path.stem[:30]}-{stamp}".replace(" ", "-")

    print(f"\n{C.BOLD}任務：{C.OFF}{task_title}")
    print(f"{C.BOLD}規格：{C.OFF}{spec_path}（{len(spec)} 字元）")
    print(f"{C.BOLD}分支：{C.OFF}{branch}")

    if not ask("開始執行？"):
        print("已取消。")
        return 0

    # 這幾個 import 放在前置檢查之後，避免缺相依時錯誤訊息難懂
    from pipeline_state_machine import (
        DEFAULT_EFFECTIVE_ROUNDS, MAX_ROUNDS, PipelineState, RoundRecord,
        StopReason, check_consensus, collect_scope_warnings,
    )
    from real_api_client import call_claude, call_chatgpt
    from codex_trigger import trigger_codex
    from stage4_reviewer import run_stage4

    FORBIDDEN = [".github/", ".pipeline/", "supabase/"]
    ALLOWED_HINT = [
        "請嚴格遵守規格文件中「交給協作 AI 的限制」一節所列的檔案範圍。",
        "規格未明確允許的檔案，一律不得新增、修改或刪除。",
    ]

    sh(["git", "checkout", "-b", branch], check=True)
    report = {"spec_path": str(spec_path)}

    # ---------- Stage 2 ----------
    title("Stage 2　需求交叉檢查")
    dim("Claude 與 ChatGPT 各看一次規格，預設放行，只有四種情況會擋下來")

    state = PipelineState(task_id=branch)
    claude_reply = chatgpt_reply = ""
    for i in range(1, min(DEFAULT_EFFECTIVE_ROUNDS, MAX_ROUNDS) + 1):
        print(f"\n  第 {i} 輪：呼叫 Claude...")
        claude_reply = call_claude(spec, chatgpt_reply)
        print(f"\n{C.DIM}  Claude：{C.OFF}{claude_reply.strip()[:600]}")

        print(f"\n  第 {i} 輪：呼叫 ChatGPT...")
        chatgpt_reply = call_chatgpt(spec, claude_reply)
        print(f"\n{C.DIM}  ChatGPT：{C.OFF}{chatgpt_reply.strip()[:600]}")

        state.history.append(RoundRecord(
            round_number=i, claude_output=claude_reply,
            chatgpt_output=chatgpt_reply,
            timestamp=datetime.now(timezone.utc).isoformat(),
        ))
        state.final_round = i

        w = collect_scope_warnings(claude_reply) + collect_scope_warnings(chatgpt_reply)
        if w:
            state.scope_warnings.extend(w)
            warn(f"命中關注關鍵字（僅記錄，不中止）：{set(w)}")

        if check_consensus(claude_reply, chatgpt_reply):
            state.stop_reason = StopReason.CONSENSUS.value
            break
        state.stop_reason = StopReason.ROUNDS_EXHAUSTED.value

    report["stage2"] = state.to_dict()

    if state.stop_reason != StopReason.CONSENSUS.value:
        fail("審查被擋下，流程停止")
        dim("上面的回覆裡會說明是命中哪一項阻擋條件")
        sh(["git", "checkout", "main"])
        sh(["git", "branch", "-D", branch])
        dim(f"已刪除分支 {branch}")
        return 1
    ok("Stage 2 放行")

    # ---------- Stage 3 ----------
    title("Stage 3　Codex 執行修改")
    dim("這一段最久，中間可能一片安靜，是它在讀檔案跟思考")

    codex = trigger_codex(branch, spec, ALLOWED_HINT, forbidden_paths=FORBIDDEN)
    report["stage3"] = {
        "ok": codex["stage3_ok"], "reason": codex.get("reason"),
        "stdout_tail": codex.get("stdout", "")[-3000:],
    }
    if not codex["stage3_ok"]:
        fail(f"Stage 3 失敗：{codex.get('reason')}")
        return 1
    ok("Codex 完成，已產生變更")

    # 硬邊界檢查
    sh(["git", "add", "-A"])
    changed = sh(["git", "diff", "--cached", "--name-only", "main"]).stdout.strip().split("\n")
    changed = [c for c in changed if c]
    print()
    for c in changed:
        print(f"    {c}")

    violated = [c for c in changed if any(c.startswith(p) for p in FORBIDDEN)]
    if violated:
        fail(f"動到了禁止路徑：{violated}")
        dim("已中止。請檢查規格是否寫得不夠明確。")
        return 1
    ok("路徑檢查通過")

    # ---------- Stage 4 ----------
    title("Stage 4　審查產出")
    review = run_stage4(spec)
    report["stage4"] = review

    # ---------- Stage 5 ----------
    title("Stage 5　產生報告")
    report["tests_run"] = ["Stage 2 需求交叉檢查", "Stage 4 驗收條件比對"]
    report["tests_not_run"] = [
        "實機測試：iPhone／iPad 上的實際行為",
        "Service Worker 快取更新後的行為",
        "桌面瀏覽器行為（過往經驗顯示可能與觸控裝置不同）",
    ]
    report["known_limitations"] = [
        "Stage 4 只讀 git diff，未讀取完整 repo context",
        "Stage 4 未達標時不會自動退回 Codex，需人工處理",
    ]
    report["user_actions"] = [
        "逐行確認 diff",
        "若改動涉及前端檔案，執行 bump_versions.py 更新版本號",
        "實機測試後才合併",
    ]

    import json
    Path("pipeline_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        from stage5_report import build_report
        build_report(report_data=report, spec_title=task_title,
                     output_path="完成報告.docx")
        ok("完成報告.docx 已產生在 repo 根目錄")
    except Exception as e:
        warn(f"報告產生失敗（不影響結果）：{e}")

    # ---------- 結論 ----------
    title("結果")
    if review["meets_spec"]:
        ok("審查判定：達標")
    else:
        fail("審查判定：未達標")
    print(f"\n  {review.get('notes', '')}")
    for c in review.get("unmet_conditions", []):
        fail(f"未達成：{c}")
    for v in review.get("violations", []):
        fail(f"違反限制：{v}")

    print(f"\n{C.BOLD}變更還在本機，尚未推送。{C.OFF}")
    dim("你可以先用編輯器或 git diff --cached 看過內容再決定。")

    if not ask("要建立 draft PR 嗎？"):
        print(f"\n變更保留在分支 {branch}，隨時可以自己處理。")
        print(f"放棄的話：git checkout main && git branch -D {branch}")
        return 0

    verdict = "PASS" if review["meets_spec"] else "FAIL"
    prefix = "[自動·已通過審查]" if review["meets_spec"] else "[自動·審查未通過]"
    sh(["git", "commit", "-m", f"auto: {task_title}"], check=True)
    sh(["git", "push", "-u", "origin", branch], check=True)
    r = sh([
        "gh", "pr", "create", "--draft",
        "--title", f"{prefix} {task_title}",
        "--body", f"由本機管線產生。審查判定：{verdict}。\n\n{review.get('notes','')}",
        "--base", "main", "--head", branch,
    ])
    if r.returncode == 0:
        ok(f"PR 已建立：{r.stdout.strip()}")
    else:
        fail("建立 PR 失敗")
        dim(r.stderr.strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
