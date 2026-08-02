"""
Task01C 真實串接模組：用 Task01B 驗證過的方式呼叫 Claude API 與 OpenAI API，
取代狀態機測試階段用的假資料。

沿用 Task01B 驗證過的兩個 endpoint 與呼叫方式，沒有引入新的技術路徑，
所以不需要再重新驗證平台能力，只是把「單次呼叫」擴充成「多輪，且每輪
都要看得懂上一輪對方說了什麼」。
"""

import os
import requests

CLAUDE_API_URL = "https://api.anthropic.com/v1/messages"
OPENAI_API_URL = "https://api.openai.com/v1/responses"

SHARED_REVIEW_RULES = """這份規格在交給你之前，使用者已經跟另一位 AI 詳細討論並確認過了。
你的預設立場是**放行**。這個管線的目的是讓使用者下一次指令就能自動跑完，
每一次不必要的阻擋都會直接破壞這個目的，所以阻擋的門檻設得非常高。

【唯一允許阻擋的四種情況】
只有下列四種情況才可以標記阻擋，除此之外一律放行：

1. 機密外洩：規格會導致 API 金鑰、service_role key、私鑰等機密
   出現在 repository、PR、log 或對話中。
2. 程式本體崩潰：規格若照做，會讓網站或 App 直接壞掉無法運作。
   例如前端程式依賴一個尚未建立的資料庫欄位就先合併。
3. 不可逆的資料損失：規格要求永久刪除使用者資料，
   而非該專案規定的封存作法。
4. 明確違反架構紅線且是「真的要做」：規格實際要求導入
   React／Vue／Next.js 等前端框架、hash 路由、UI 或動畫函式庫、
   外部 CDN、圖示字型，或讓 AI 模型不經後端驗證直接寫資料庫。
   注意：只有規格「真的要求做這些事」才算；如果只是在複述
   「不可以導入框架」這類限制條款，那是正確的，不是違規。

【以下情況一律不得阻擋，直接放行】
- 你覺得規格可以寫得更完整、更嚴謹
- 你想建議更好的實作方式、更好的命名、更好的架構
- 缺少測試、缺少錯誤處理、缺少邊界情況的說明
- 描述有點模糊，但意思大致看得懂
- 你想再確認一下某個細節
- 效能、可維護性、擴充性方面的顧慮
- 任何「如果之後要⋯⋯可能會⋯⋯」這類推測性的擔憂

以上這些都可以寫出來當作建議，但**不要因此阻擋**。
判斷不確定的時候，一律選擇放行。

【輸出格式】
若命中上述四種情況之一，在回覆最後一行單獨寫：
REVIEW_BLOCKED
並具體說明是命中第幾項、為什麼。

若沒有命中，就不要出現 REVIEW_BLOCKED 這個字串
（連「我沒有要寫 REVIEW_BLOCKED」這種句子都不要寫，會被程式誤判）。
有建議就直接寫建議，回覆盡量簡短。"""

CLAUDE_SYSTEM_PROMPT = f"""你是這個自動協作管線裡的第一位需求審查者。
你會收到一份需求規格，以及 ChatGPT（第二位審查者）上一輪的意見
（第一輪沒有上一輪意見）。

{SHARED_REVIEW_RULES}"""

CHATGPT_SYSTEM_PROMPT = f"""你是這個自動協作管線裡的第二位審查者，
跟 Claude 交叉檢查一份需求規格。
你會收到需求規格，以及 Claude 上一輪的意見。

{SHARED_REVIEW_RULES}"""


def call_claude(spec: str, chatgpt_last_reply: str) -> str:
    api_key = os.environ["ANTHROPIC_API_KEY"]
    user_content = (
        f"需求規格：\n{spec}\n\n"
        f"ChatGPT 上一輪意見：\n{chatgpt_last_reply or '（第一輪，尚無意見）'}"
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
            "max_tokens": 500,
            "system": CLAUDE_SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": user_content}],
        },
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    return "".join(block.get("text", "") for block in data.get("content", []))


def call_chatgpt(spec: str, claude_last_reply: str) -> str:
    api_key = os.environ["OPENAI_API_KEY"]
    user_content = f"需求規格：\n{spec}\n\nClaude 上一輪意見：\n{claude_last_reply}"
    resp = requests.post(
        OPENAI_API_URL,
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {api_key}",
        },
        json={
            "model": "gpt-5.1",
            "instructions": CHATGPT_SYSTEM_PROMPT,
            "input": user_content,
        },
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()

    # Responses API 的輸出結構可能因版本而異，先試簡便欄位，
    # 拿不到再退回手動組裝，避免 API 格式微調就直接整段掛掉
    output_text = data.get("output_text")
    if output_text:
        return output_text

    chunks = []
    for item in data.get("output", []):
        for c in item.get("content", []):
            if c.get("type") == "output_text":
                chunks.append(c.get("text", ""))
    return "".join(chunks)
