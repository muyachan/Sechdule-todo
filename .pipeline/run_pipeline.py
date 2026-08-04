"""
通用管線執行程式

與前一版 run_task02.py 的差別：
  - 規格不再從檔案讀取，改從環境變數 TASK_SPEC 取得
    （由 workflow 從 GitHub Issue 內容帶入）
  - 允許修改的檔案範圍由規格自己定義，不再寫死在程式裡
  - 一支程式適用所有任務，不用每個任務複製一份

放在 .pipeline/ 底下，從 repo 根目錄執行：
  TASK_SPEC="..." python3 .pipeline/run_pipeline.py
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from pipeline_state_machine import (
    DEFAULT_EFFECTIVE_ROUNDS,
    MAX_ROUNDS,
    PipelineState,
    RoundRecord,
    StopReason,
    check_consensus,
    collect_scope_warnings,
)
from real_api_client import call_claude, call_chatgpt
from codex_trigger import trigger_codex
from stage4_reviewer import run_stage4

# 這份禁止清單是程式層的硬邊界，不隨任務改變。
# .github/ 是因為 GITHUB_TOKEN 沒有修改 workflow 的權限，改了 push 會失敗；
# .pipeline/ 是管線自己的程式，不該被它修改。
FORBIDDEN_PATHS = [
    ".github/",
    ".pipeline/",
    "supabase/",
    "任何 .sql 檔（SQL 一律由使用者自行在 Supabase 執行）",
]

# 允許範圍改由規格自己定義，這裡只指路，維持單一事實來源
ALLOWED_FILES_HINT = [
    "請嚴格遵守規格文件中「交給協作 AI 的限制」一節所列的檔案範圍。",
    "規格未明確允許的檔案，一律不得新增、修改或刪除。",
]


def load_spec() -> str:
    spec = os.environ.get("TASK_SPEC", "").strip()
    if not spec:
        print("錯誤：環境變數 TASK_SPEC 是空的，沒有規格可執行")
        sys.exit(1)
    return spec


def stage2_review(spec: str, task_id: str,
                  effective_rounds: int = DEFAULT_EFFECTIVE_ROUNDS) -> PipelineState:
    round_limit = min(effective_rounds, MAX_ROUNDS)
    state = PipelineState(task_id=task_id)

    claude_reply = ""
    chatgpt_reply = ""

    for i in range(1, round_limit + 1):
        claude_reply = call_claude(spec, chatgpt_reply)
        chatgpt_reply = call_chatgpt(spec, claude_reply)

        state.history.append(RoundRecord(
            round_number=i,
            claude_output=claude_reply,
            chatgpt_output=chatgpt_reply,
            timestamp=datetime.now(timezone.utc).isoformat(),
        ))
        state.final_round = i

        warnings = collect_scope_warnings(claude_reply) + collect_scope_warnings(chatgpt_reply)
        if warnings:
            state.scope_warnings.extend(warnings)
            print(f"[Stage 2] 第 {i} 輪命中關注關鍵字（僅記錄）：{set(warnings)}")

        if check_consensus(claude_reply, chatgpt_reply):
            state.stop_reason = StopReason.CONSENSUS.value
            return state

        if i == round_limit:
            state.stop_reason = StopReason.ROUNDS_EXHAUSTED.value
            return state

    state.stop_reason = StopReason.ROUNDS_EXHAUSTED.value
    return state


def _save(report: dict):
    Path("pipeline_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


def _write_verdict(passed: bool):
    Path("stage4_verdict.txt").write_text("PASS" if passed else "FAIL", encoding="utf-8")


def _generate_report(report: dict, title: str):
    try:
        from stage5_report import build_report
        build_report(report_data=report, spec_title=title, output_path="完成報告.docx")
        print("[Stage 5] 完成報告.docx 已產生")
    except Exception as e:
        print(f"[Stage 5] 報告產生失敗（不影響管線結果）：{e}")


def main():
    spec = load_spec()
    task_title = os.environ.get("TASK_TITLE", "未命名任務")
    task_id = os.environ.get("TASK_ID", "task-unnamed")

    report = {"spec_path": f"GitHub Issue：{task_title}"}

    print("=" * 50)
    print(f"任務：{task_title}")
    print("Stage 2：Claude ↔ ChatGPT 交叉檢查")
    print("=" * 50)
    state = stage2_review(spec, task_id)
    report["stage2"] = state.to_dict()

    for r in state.history:
        print(f"\n--- 第 {r.round_number} 輪 ---")
        print(f"Claude: {r.claude_output}\n")
        print(f"ChatGPT: {r.chatgpt_output}")

    if state.stop_reason != StopReason.CONSENSUS.value:
        print(f"\n審查被擋下（{state.stop_reason}），流程停止，不進入 Stage 3")
        _save(report)
        _write_verdict(False)
        _generate_report(report, task_title)
        sys.exit(1)

    print("\nStage 2 放行\n")

    print("=" * 50)
    print("Stage 3：Codex 執行修改")
    print("=" * 50)
    codex_result = trigger_codex(
        task_id, spec, ALLOWED_FILES_HINT, forbidden_paths=FORBIDDEN_PATHS,
    )
    report["stage3"] = {
        "ok": codex_result["stage3_ok"],
        "reason": codex_result.get("reason"),
        "stdout_tail": codex_result.get("stdout", "")[-3000:],
    }

    if not codex_result["stage3_ok"]:
        print("\nStage 3 失敗，流程停止")
        _save(report)
        _write_verdict(False)
        _generate_report(report, task_title)
        sys.exit(1)

    print("\n" + "=" * 50)
    print("Stage 4：Claude 審查產出")
    print("=" * 50)
    review = run_stage4(spec)
    report["stage4"] = review

    report["tests_run"] = [
        "Stage 2 需求交叉檢查（Claude + ChatGPT）",
        "Stage 4 驗收條件逐條比對",
    ]
    report["tests_not_run"] = [
        "實機測試：iPhone／iPad 上的實際行為",
        "Service Worker 快取更新後的行為",
        "桌面瀏覽器行為（過往經驗顯示可能與觸控裝置不同）",
    ]
    report["known_limitations"] = [
        "Stage 4 只讀取 git diff，未讀取完整 repo context，"
        "無法判斷改動是否影響 diff 以外的程式",
        "Stage 4 判定未達標時不會自動退回 Codex 重做，需人工處理",
    ]
    report["user_actions"] = [
        "打開 PR 逐行確認 diff",
        "若改動涉及前端檔案，bump index.html 的 ?v= 與 sw.js 的 CACHE_NAME",
        "若新增了前端檔案，記得把它加進 sw.js 的 APP_SHELL 清單",
        "實機測試後才合併",
    ]

    _save(report)
    _write_verdict(review["meets_spec"])
    _generate_report(report, task_title)

    if not review["meets_spec"]:
        print("\n審查判定未達標。仍會建立 draft PR 供你檢視。")
        sys.exit(1)

    print("\n全部通過。變更已在工作目錄，接下來由 workflow 建立 PR。")


if __name__ == "__main__":
    main()
