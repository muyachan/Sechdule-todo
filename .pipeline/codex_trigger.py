"""
Stage 3：真實觸發 Codex

沿用 Task01B 驗證過的做法，四個已知的平台坑都已在 workflow 層面處理：
  1. codex login 用 pipe 方式（--api-key 已被官方棄用）
  2. Platform API 餘額與 ChatGPT 訂閱是分開的兩本帳
  3. ubuntu-latest 需先放寬 unprivileged user namespace 限制
  4. repo 需開啟 Actions 建立 PR 的權限

這支只負責「把規格轉成給 Codex 的指令」與「執行並回報結果」，
不負責判斷成果好不好——那是 Stage 4 的事。
"""

import os
import shutil
import subprocess


def build_codex_prompt(spec_text: str, allowed_files: list, forbidden_paths: list = None) -> str:
    """
    把 Stage 0 的規格轉成給 Codex 的指令。
    刻意把「允許修改的檔案」明確列出來並重複強調，
    這既是安全邊界，也是成本控制（避免 Codex 掃描整個 repo）。
    """
    forbidden_paths = forbidden_paths or []
    files_list = "\n".join(f"  - {f}" for f in allowed_files)
    forbidden_block = ""
    if forbidden_paths:
        items = "\n".join(f"  - {p}" for p in forbidden_paths)
        forbidden_block = f"""
以下路徑絕對不可修改、新增或刪除任何內容：
{items}
"""

    return f"""請先讀取 repo 根目錄的 AGENTS.md，理解專案限制後再開始。

以下是這次任務的完整需求規格：

{spec_text}

【嚴格限制】
你只被允許修改以下檔案：
{files_list}
{forbidden_block}
除了上列允許的檔案，不得新增、修改、刪除任何其他檔案。
不得引入任何框架或外部函式庫。

如果你認為必須修改清單以外的檔案才能完成任務，
請停止並說明原因，不要自行擴大修改範圍。

完成後請簡短說明你改了什麼、為什麼這樣改。
"""


def run_codex(prompt: str, max_retries: int = 0) -> dict:
    """
    執行 codex exec。回傳結果 dict，不拋例外，
    讓呼叫端（狀態機）決定怎麼處理失敗。

    max_retries 預設 0：失敗就失敗，不自動重試。
    重試會讓成本翻倍且通常不會神奇地成功，
    有問題應該回報給使用者判斷。
    """
    try:
        codex_path = shutil.which("codex") or "codex"
        result = subprocess.run(
            [codex_path, "exec", "--sandbox", "workspace-write", prompt],
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=900,  # 15 分鐘上限，避免卡死燒額度
        )
        return {
            "success": result.returncode == 0,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "stdout": "",
            "stderr": "Codex 執行超過 15 分鐘上限，已中止",
            "returncode": -1,
        }


def has_uncommitted_changes() -> bool:
    """
    確認 Codex 真的改了東西。
    Task01B 踩過這個坑：Codex 失敗時 git 是乾淨的，
    後續 commit 步驟會因為「nothing to commit」而失敗，
    錯誤訊息會誤導人以為是 git 出問題。
    """
    result = subprocess.run(
        ["git", "status", "--porcelain"],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    return bool(result.stdout.strip())


def trigger_codex(task_id: str, spec_text: str, allowed_files: list,
                  forbidden_paths: list = None) -> dict:
    """
    取代 fake_trigger_codex。
    """
    print(f"[Stage 3] 開始執行 task {task_id}")
    prompt = build_codex_prompt(spec_text, allowed_files, forbidden_paths)
    result = run_codex(prompt)

    if not result["success"]:
        print(f"[Stage 3] Codex 執行失敗（returncode={result['returncode']}）")
        print(result["stderr"][:2000])
        return {"stage3_ok": False, "reason": "codex_failed", **result}

    if not has_uncommitted_changes():
       if not has_uncommitted_changes():
        print("[Stage 3] Codex 回報成功，但工作目錄沒有任何變更")
        print("[Stage 3] 以下是 Codex 的完整輸出，通常會說明它為什麼沒有動手：")
        print("-" * 60)
        print(result["stdout"][-4000:])
        print("-" * 60)
        return {"stage3_ok": False, "reason": "no_changes_made", **result}

    print("[Stage 3] Codex 完成，已產生變更")
    return {"stage3_ok": True, **result}
