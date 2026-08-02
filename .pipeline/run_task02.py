"""
Task02 執行主程式（跑在正式 repo Sechdule-todo）

放在 .pipeline/ 底下，與 PWA 本體程式碼隔離。
從 repo 根目錄執行：python3 .pipeline/run_task02.py

與試跑版的差異：
  - 規格改讀 Task02 的正式需求
  - 允許修改的檔案改成真實檔案
  - 明確排除 .github/ 與 .pipeline/
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# 讓同資料夾的模組可以被 import（因為是從 repo 根目錄執行的）
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

SPEC_PATH = ".pipeline/Task02-需求規格.md"

ALLOWED_FILES = [
    "scripts/daily-reminder.mjs",
    "script.js",
    "新增一支共用查詢條件定義檔（檔名由你決定，須放在 repo 既有結構內，"
    "不可放在 .github/ 或 .pipeline/）",
]

# 明確禁止清單，會一併寫進給 Codex 的指令。
# .github/ 是因為 GITHUB_TOKEN 沒有修改 workflow 的權限，改了會 push 失敗；
# .pipeline/ 是管線自己的程式，不該被它修改。
FORBIDDEN_PATHS = [
    ".github/",
    ".pipeline/",
    "supabase/",
    "index.html",
    "style.css",
    "sw.js",
    "任何 .sql 檔",
]


def load_spec() -> str:
    return Path(SPEC_PATH).read_text(encoding="utf-8")


def stage2_review(spec: str, effective_rounds: int = DEFAULT_EFFECTIVE_ROUNDS) -> PipelineState:
    round_limit = min(effective_rounds, MAX_ROUNDS)
    state = PipelineState(task_id="task02-daily-reminder-archived")

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


def _generate_report(report: dict):
    try:
        from stage5_report import build_report
        build_report(
            report_data=report,
            spec_title="Task02｜每日提醒讀取封存項目",
            output_path="完成報告.docx",
        )
        print("[Stage 5] 完成報告.docx 已產生")
    except Exception as e:
        print(f"[Stage 5] 報告產生失敗（不影響管線結果）：{e}")


def main():
    spec = load_spec()
    report = {"spec_path": SPEC_PATH}

    print("=" * 50)
    print("Stage 2：Claude ↔ ChatGPT 交叉檢查")
    print("=" * 50)
    state = stage2_review(spec)
    report["stage2"] = state.to_dict()

    for r in state.history:
        print(f"\n--- 第 {r.round_number} 輪 ---")
        print(f"Claude: {r.claude_output}\n")
        print(f"ChatGPT: {r.chatgpt_output}")

    if state.stop_reason != StopReason.CONSENSUS.value:
        print(f"\n審查被擋下（{state.stop_reason}），流程停止，不進入 Stage 3")
        _save(report)
        _generate_report(report)
        sys.exit(1)

    print("\nStage 2 放行\n")

    print("=" * 50)
    print("Stage 3：Codex 執行修改")
    print("=" * 50)
    codex_result = trigger_codex(
        "task02-daily-reminder-archived",
        spec,
        ALLOWED_FILES,
        forbidden_paths=FORBIDDEN_PATHS,
    )
    report["stage3"] = {
        "ok": codex_result["stage3_ok"],
        "reason": codex_result.get("reason"),
        "stdout_tail": codex_result.get("stdout", "")[-3000:],
    }

    if not codex_result["stage3_ok"]:
        print("\nStage 3 失敗，流程停止")
        _save(report)
        _generate_report(report)
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
        "實機測試：iPhone／iPad 上實際收到的提醒內容",
        "排程實際執行結果（需等下一次每日排程觸發，或手動觸發 daily-reminder）",
        "前端 fetchTodos() 行為是否與修改前完全一致（需實際開啟 App 確認）",
        "Service Worker 快取更新後的行為",
    ]
    report["known_limitations"] = [
        "Stage 4 只讀取 git diff，未讀取完整 repo context，"
        "無法判斷改動是否影響 diff 以外的程式",
        "Stage 4 判定未達標時不會自動退回 Codex 重做，需人工處理",
        "daily-reminder.yml 的 concurrency 設定不在本次範圍，需你手動加上",
    ]
    report["user_actions"] = [
        "打開下方 PR，逐行確認 diff，特別注意 script.js 的 fetchTodos() 行為沒有被改變",
        "若 script.js 有實質改動，記得 bump index.html 的 ?v= 與 sw.js 的 CACHE_NAME",
        "手動為 .github/workflows/daily-reminder.yml 加上 concurrency 設定",
        "合併後手動觸發一次 daily-reminder，確認提醒內容不再包含已封存項目",
        "確認提醒的事項數量從 15 件降為實際的 4 件左右",
    ]

    _save(report)

    if not review["meets_spec"]:
        print("\n審查判定未達標。這一版不會自動退回 Codex，請人工檢視。")
        _generate_report(report)
        sys.exit(1)

    print("\n全部通過。變更已在工作目錄，接下來由 workflow 建立 PR。")
    _generate_report(report)


if __name__ == "__main__":
    main()
