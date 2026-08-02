"""
Stage 4：Claude 審查 Codex 的產出

這一版刻意用最便宜的做法——只讀 git diff，不讀整個 repo。
若之後發現「diff 看起來對、實際跑起來壞掉」的情況太多，
再升級成 claude-code-action（能讀完整 repo context，但成本高數倍）。

輸出強制為 JSON，不在自由文字裡抓關鍵字，
避免 Stage 2 那種「模型忘記寫標記字串」的脆弱問題。

【2026-08-01 修正】
第一次試跑時 Stage 4 直接判定未達標，但 Claude 根本沒被呼叫到。
原因是原本用 `git diff main...HEAD` 比較 commit，
而此時 Codex 的變更還在工作目錄、尚未 commit，HEAD 等於 main，
diff 是空的，於是程式在呼叫 API 前就自己提前返回了。
現在改為先 `git add -A` 再比較索引（--cached），
並在取不到 diff 時印出 git status 協助診斷，不再靜默失敗。
"""

import json
import os
import subprocess

import requests

CLAUDE_API_URL = "https://api.anthropic.com/v1/messages"

REVIEW_SYSTEM_PROMPT = """你是自動協作管線的產出審查者。
你會收到一份需求規格（含驗收條件）與一份 git diff，
判斷這個 diff 有沒有達成規格的最低必要成果。

【判斷原則】
逐條對照驗收條件，不要憑印象。
只判斷「有沒有達成規格要求的事」，不要評論規格本身好不好。

【不該讓它不通過的情況】
- 命名可以更好、可以再加註解、可以更優雅
- 缺少測試（除非規格明確要求測試）
- 你想到的其他改進建議

這些寫進 notes 就好，不要因此判定不通過。

【該讓它不通過的情況】
- 有驗收條件明確沒達成
- 修改了規格禁止修改的檔案
- 引入了規格禁止的東西（框架、函式庫、CDN）
- 改動會讓既有功能壞掉

【輸出格式】
只輸出 JSON，前後不要有任何其他文字、不要有 markdown 的程式碼框：
{
  "meets_spec": true 或 false,
  "unmet_conditions": ["沒達成的驗收條件，逐條列出"],
  "violations": ["違反的限制，例如改了不該改的檔案"],
  "notes": "簡短說明，一兩句話",
  "code_explanation": {
    "overview": "這次改動整體上在做什麼、採用什麼設計思路，三到五句話",
    "functions": [
      {
        "name": "檔名：函式名或常數名",
        "purpose": "它負責什麼",
        "how": "它實際怎麼做到的",
        "note": "為什麼這樣寫，或閱讀時要注意什麼。沒有特別的就寫「—」"
      }
    ]
  }
}

【寫 code_explanation 的要求】
讀者是能看懂邏輯、但還在學語法的人，所以：
- 用白話解釋語法做了什麼，例如展開運算子、Object.freeze 這類寫法要說明作用
- 說明「為什麼這樣寫」，不要只說「這樣寫」
- 每個被新增或明顯修改的函式、常數都要列進 functions
- 不要為了湊數把沒改到的東西也列進去
- 不要用「顯然」「簡單來說」這類詞，直接講內容"""


def _stage_all_changes():
    """
    先把所有變更加入索引，才能正確取得 diff。

    兩個必要理由：
      1. Codex 的變更此時還在工作目錄，尚未 commit，
         所以不能用 main...HEAD 這種比較 commit 的方式。
      2. 新增的檔案是 untracked，一般的 git diff 完全看不到它們，
         必須先 git add 才會出現在 diff 裡。
    """
    subprocess.run(["git", "add", "-A"], capture_output=True)


def get_diff(base_branch: str = "main") -> str:
    _stage_all_changes()
    result = subprocess.run(
        ["git", "diff", "--cached", base_branch],
        capture_output=True,
        text=True,
    )
    return result.stdout


def get_changed_files(base_branch: str = "main") -> list:
    _stage_all_changes()
    result = subprocess.run(
        ["git", "diff", "--cached", "--name-only", base_branch],
        capture_output=True,
        text=True,
    )
    return [f for f in result.stdout.strip().split("\n") if f]


def review_diff(spec_text: str, diff_text: str, changed_files: list) -> dict:
    api_key = os.environ["ANTHROPIC_API_KEY"]

    # diff 可能很長，先截斷避免單次成本失控。
    # 若被截斷會在 notes 裡反映出來，不會靜默省略。
    MAX_DIFF_CHARS = 60000
    truncated = len(diff_text) > MAX_DIFF_CHARS
    if truncated:
        diff_text = diff_text[:MAX_DIFF_CHARS] + "\n\n[diff 過長，此處已截斷]"

    user_content = (
        f"需求規格：\n{spec_text}\n\n"
        f"這次改動的檔案清單：\n" + "\n".join(f"- {f}" for f in changed_files) +
        f"\n\ngit diff：\n{diff_text}"
    )

    resp = requests.post(
        CLAUDE_API_URL,
        headers={
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        json={
            "model": "claude-sonnet-4-6",
            "max_tokens": 1500,
            "system": REVIEW_SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": user_content}],
        },
        timeout=120,
    )
    resp.raise_for_status()
    data = resp.json()
    text = "".join(block.get("text", "") for block in data.get("content", []))

    # 模型偶爾還是會包 markdown 程式碼框，容錯處理
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned
        cleaned = cleaned.rsplit("```", 1)[0]
    cleaned = cleaned.strip()

    try:
        result = json.loads(cleaned)
    except json.JSONDecodeError:
        # 解析失敗時不要猜，直接標成需要人工介入
        return {
            "meets_spec": False,
            "unmet_conditions": [],
            "violations": [],
            "notes": f"審查結果無法解析為 JSON，需人工檢視。原始回覆：{text[:500]}",
            "code_explanation": {"overview": "（審查結果解析失敗，無法產生程式說明）",
                                 "functions": []},
            "parse_failed": True,
        }

    result.setdefault("code_explanation", {"overview": "（本次未產生程式說明）", "functions": []})
    result["parse_failed"] = False
    if truncated:
        result["notes"] = (result.get("notes", "") + "（註：diff 過長已截斷，審查可能不完整）")
    return result


def run_stage4(spec_text: str, base_branch: str = "main") -> dict:
    changed_files = get_changed_files(base_branch)
    diff_text = get_diff(base_branch)

    if not diff_text.strip():
        # 這裡是第一次試跑踩過的坑：靜默返回會讓人以為是 Claude 判定未達標，
        # 實際上 Claude 根本沒被呼叫。所以印出足夠的診斷資訊。
        print("[Stage 4] 取不到 diff，Claude 未被呼叫")
        print("[Stage 4] 可能原因：Codex 沒有真的改東西，或 git 狀態異常")
        print("[Stage 4] 目前 git status：")
        subprocess.run(["git", "status", "--short"])
        return {
            "meets_spec": False,
            "unmet_conditions": ["沒有任何變更可供審查"],
            "violations": [],
            "notes": "diff 是空的，Stage 3 可能沒有真的做事，或 diff 取得方式有問題",
            "code_explanation": {"overview": "（沒有變更，無程式說明）", "functions": []},
            "parse_failed": False,
        }

    print(f"[Stage 4] 審查 {len(changed_files)} 個檔案的變更：")
    for f in changed_files:
        print(f"  - {f}")
    print(f"[Stage 4] diff 長度：{len(diff_text)} 字元")

    result = review_diff(spec_text, diff_text, changed_files)

    print(f"\n[Stage 4] 判定：{'達標' if result['meets_spec'] else '未達標'}")
    if result.get("unmet_conditions"):
        print("未達成的條件：")
        for c in result["unmet_conditions"]:
            print(f"  - {c}")
    if result.get("violations"):
        print("違反的限制：")
        for v in result["violations"]:
            print(f"  - {v}")
    print(f"說明：{result.get('notes', '')}")

    return result
