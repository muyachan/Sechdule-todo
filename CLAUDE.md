# 給 Claude Code 的操作說明

本檔案是操作流程。治理規範見 AGENTS.md，衝突時以 AGENTS.md 為準。
與使用者對話一律使用繁體中文。

## 環境

- Windows 11 + PowerShell 5.1，系統 locale 為日文（cp932）
- repo：C:\Users\winni\Documents\Sechdule-todo
- `pip` 指令已損壞，一律使用 `python -m pip`
- 你的 bash 沙箱可能無法對外連線；push 與 gh 指令失敗時，
  請把指令交給使用者在自己的終端機執行

## 什麼可以直接改，什麼要走管線

可以直接改（純視覺，不碰資料與邏輯）：
- style.css 的顏色、間距、圓角、陰影、動畫
- 文案錯字
- 註解

一律走管線：
- script.js 任何改動
- scripts/ 底下任何檔案
- 任何碰到資料查詢、過濾條件、寫入路徑的改動
- 任何新增或修改資料表結構的工作

不確定就走管線。

## 你不能碰的路徑

.github/、.pipeline/、supabase/ 是管線的硬邊界。
但那是限制「管線」，不是限制你——這三處的修改本來就只能由你或
使用者手動處理。動它們時仍要開分支、開 PR，不可直接改 main。

## 跑管線的流程

### 1. 寫規格

規格檔放在 C:\Users\winni\Documents\ 底下，不要放進 repo
（放進去會讓工作目錄變髒，前置檢查會拒絕執行）。

規格必須包含：
- 只需讀取的檔案（這是成本控制，Stage 3 佔總成本 75–90%）
- 問題描述與根因
- 執行者不知道但必須知道的結構資訊
- 唯一目標
- 最低必要成果（逐項列出，不要把多個目標寫在同一條）
- 明確不處理
- 驗收條件

寫完後把規格內容顯示給使用者，並詢問是否啟動。
未經確認不要啟動管線——啟動即開始產生 API 費用。

### 2. 前置確認

啟動前確認：在 main 分支上、工作目錄乾淨。
不符合就停下來回報，不要自行處理。

### 3. 啟動

用獨立視窗執行，不要在你的工作階段裡直接跑
（管線會在建立 PR 前停下來等 y/n，你無法回答；
且 Stage 3 的串流輸出量很大，不需要進入你的 context）：

Start-Process powershell -ArgumentList '-NoExit','-Command',
  'cd C:\Users\winni\Documents\Sechdule-todo;
   python .pipeline\run_local.py <規格檔路徑> 2>&1 |
   Tee-Object -FilePath C:\Users\winni\Documents\pipeline-log.txt'

啟動後告訴使用者：管線在另一個視窗執行，
Stage 3 需要 5–15 分鐘，建立 PR 前會停下來詢問。

### 4. 結果

使用者回報跑完之後：

- 成功：讀 log 檔最後 50 行即可，不要讀全文
- 失敗：讀 log 全文進行診斷

log 檔可能是 UTF-16 編碼（Tee-Object 在 PowerShell 5.1 的預設行為），
讀取時若出現亂碼，改用 -Encoding 參數重讀。

## 管線中止後的清理

管線中止時不會自動還原工作目錄，Codex 的改動會留在暫存區。
提醒使用者執行：

  git checkout -- .
  git checkout main
  git branch          # 檢查殘留的 auto/ 分支

## 版本號

不要修改 index.html 的 ?v= 或 sw.js 的 CACHE_NAME。
那由 .pipeline/bump_versions.py 專責管理（見 AGENTS.md）。
你的責任是評估「這次改動需不需要 bump」並回報，不動手。
