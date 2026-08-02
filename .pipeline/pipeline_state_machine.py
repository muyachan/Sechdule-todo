"""
Task01C｜Orchestrator 狀態機骨架

只處理「輪次控制」與「停止條件判斷」，不呼叫任何真實 API，
不觸發任何真實 Codex 修改權限。

之後接 Task01B 驗證過的真實串接時：
  - round_inputs 改成即時呼叫 Claude API / OpenAI API 拿到的真實回應
  - fake_trigger_codex() 換成真正的 codex exec 呼叫
其餘的狀態機邏輯（五輪上限、三種停止路徑、重複防呆）不用動。
"""

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum

MAX_ROUNDS = 5  # 絕對上限，來自原始交接文件的治理規則，不可被超過

# 2026-07-31 決策：預設改成一輪見真章。
# 理由：多輪來回容易出現 AI 對話互相說服、矯枉過正的情況，
# 與其讓兩個模型自己討論到「同意」，不如一輪內沒有同時同意
# 就直接停下來回報使用者，由人來判斷要不要繼續。
# MAX_ROUNDS=5 保留為絕對防呆天花板（跟原始交接文件治理規則一致），
# 但正常運作路徑不會用到，除非之後明確調高 EFFECTIVE_ROUNDS。
DEFAULT_EFFECTIVE_ROUNDS = 1

# 這些關鍵字只用來「記錄警告」，不再直接中止流程。
# 原因：純字串比對無法分辨肯定與否定語氣，
# 例如 AI 回覆「這份規格沒有引入 React」也會命中 React，
# 反而變成 AI 越認真確認就越容易被誤擋。
# 真正的範圍違規判斷，改由 AI 明確標記 REVIEW_BLOCKED 負責。
SCOPE_CREEP_WATCH_KEYWORDS = [
    "React", "Next.js", "Vue", "前端框架",
    "永久刪除", "hash 路由", "重新設計 tab",
    "UI 函式庫", "動畫函式庫",
]


class StopReason(str, Enum):
    CONSENSUS = "consensus_reached"                   # 路徑 A
    ROUNDS_EXHAUSTED = "rounds_exhausted_needs_user"   # 路徑 B
    SCOPE_CREEP = "scope_creep_detected"               # 路徑 C
    DUPLICATE_TASK = "duplicate_task_rejected"         # 重複觸發防呆


@dataclass
class RoundRecord:
    round_number: int
    claude_output: str
    chatgpt_output: str
    timestamp: str

    def to_dict(self):
        return {
            "round_number": self.round_number,
            "claude_output": self.claude_output,
            "chatgpt_output": self.chatgpt_output,
            "timestamp": self.timestamp,
        }


@dataclass
class PipelineState:
    task_id: str
    history: list = field(default_factory=list)
    stop_reason: str = None
    final_round: int = 0
    scope_warnings: list = field(default_factory=list)

    def to_dict(self):
        return {
            "task_id": self.task_id,
            "history": [r.to_dict() for r in self.history],
            "stop_reason": self.stop_reason,
            "final_round": self.final_round,
            "scope_warnings": sorted(set(self.scope_warnings)),
        }

    def save(self, path: str):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, ensure_ascii=False, indent=2)


def collect_scope_warnings(text: str) -> list:
    """
    只回傳命中的關鍵字清單，供稽核記錄用，不會中止流程。
    命中不代表違規——AI 在複述限制條款時也會命中，
    例如「這份規格沒有引入 React」。真正的違規判斷交給
    AI 明確標記 REVIEW_BLOCKED。
    """
    return [kw for kw in SCOPE_CREEP_WATCH_KEYWORDS if kw in text]


def check_consensus(claude_output: str, chatgpt_output: str) -> bool:
    # 預設信任、放行。只有明確標記 REVIEW_BLOCKED 才算擋下來，
    # 沒有標記 = 視為通過，直接往下走，不停下來等使用者。
    claude_blocked = "REVIEW_BLOCKED" in claude_output
    chatgpt_blocked = "REVIEW_BLOCKED" in chatgpt_output
    return not (claude_blocked or chatgpt_blocked)


def is_duplicate_task(task_id: str, existing_open_task_ids: list) -> bool:
    return task_id in existing_open_task_ids


def fake_trigger_codex(task_id: str):
    """
    佔位用。正式串接時換成真正呼叫 codex exec 開 PR 的程式碼。
    """
    print(f"[假觸發] task {task_id} 已達共識，本來會在這裡呼叫 codex exec 開 PR")


def run_pipeline(task_id: str, round_inputs: list, existing_open_task_ids=None,
                  effective_rounds: int = DEFAULT_EFFECTIVE_ROUNDS) -> PipelineState:
    """
    round_inputs: [{"claude": "...", "chatgpt": "..."}, ...]

    effective_rounds: 這次實際要跑幾輪，預設 1（一輪見真章）。
    不管傳入多大，都會被 MAX_ROUNDS（5）這個絕對上限壓住，
    這是治理規則寫死的天花板，不因為呼叫端傳了更大的數字就被突破。
    """
    existing_open_task_ids = existing_open_task_ids or []
    round_limit = min(effective_rounds, MAX_ROUNDS)
    state = PipelineState(task_id=task_id)

    if is_duplicate_task(task_id, existing_open_task_ids):
        state.stop_reason = StopReason.DUPLICATE_TASK.value
        return state

    for i, round_input in enumerate(round_inputs[:round_limit], start=1):
        claude_out = round_input["claude"]
        chatgpt_out = round_input["chatgpt"]

        state.history.append(RoundRecord(
            round_number=i,
            claude_output=claude_out,
            chatgpt_output=chatgpt_out,
            timestamp=datetime.now(timezone.utc).isoformat(),
        ))
        state.final_round = i

        # 關鍵字只記錄警告，不中止流程（避免否定語句造成誤判）
        warnings = collect_scope_warnings(claude_out) + collect_scope_warnings(chatgpt_out)
        if warnings:
            state.scope_warnings.extend(warnings)
            print(f"[警告] 第 {i} 輪命中關注關鍵字（僅記錄，不中止）：{set(warnings)}")

        if check_consensus(claude_out, chatgpt_out):
            state.stop_reason = StopReason.CONSENSUS.value
            fake_trigger_codex(task_id)
            return state

        # 這輪被擋下來了。如果還有下一輪額度（effective_rounds > 1 時），
        # 讓它有機會在下一輪重新審視；如果已經是這次額度的最後一輪，
        # 才真正停下來回報使用者，不再往下試
        if i == round_limit:
            state.stop_reason = StopReason.ROUNDS_EXHAUSTED.value
            return state

    state.stop_reason = StopReason.ROUNDS_EXHAUSTED.value
    return state
