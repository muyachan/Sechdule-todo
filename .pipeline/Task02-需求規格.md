# Task 02｜每日提醒讀取封存項目 — 需求規格

> Stage 0 產出（使用者 ↔ Claude 討論）。
> 這是自動協作管線的**第一個真實任務**，範圍刻意保持最小。
>
> 根因分析來源：Claude Code 於 2026-07-31 的唯讀分析，
> 已確認情況 (A)：前端封存寫入正常運作，使用者按 X 後該列消失且
> 重新整理不會回來。因此兩個症狀為同一根因。

---

## 唯一目標

讓 `scripts/daily-reminder.mjs` 不再讀取已封存的待辦事項，
並把 todos 的查詢過濾條件收斂到單一定義處，
使前端與排程腳本共用同一份定義。

---

## 根因摘要（給協作 AI 的背景）

`scripts/daily-reminder.mjs` 的 `fetchDueTodos()` 只過濾了
`completed_at=is.null` 與 `due_date=lte.<今天>`，
**缺少 `archived_at=is.null`**。

成因是一次沒做完的 rollout：
- `b178d3b`（2026-07-20）建立排程腳本，當時資料庫還沒有 `archived_at`
- `264f198`（2026-07-26）引入封存流程，只改動前端檔案，未觸及 `scripts/`

後果：使用者按 X 封存（`completed_at` 仍為 null、只寫入 `archived_at`）
的項目會永遠留在提醒集合中，每天被標為「已過期」重複發送，
並污染事項計數與推播內文的名額。

註：打勾完成的項目因為有 `completed_at`，會被既有條件濾掉，
所以只有「按 X 封存」的項目會出現此症狀。

---

## 最低必要成果

1. `scripts/daily-reminder.mjs` 讀取 todos 時排除 `archived_at` 非 null 的列
2. 建立一處共用的 todos 查詢條件定義，前端 `script.js` 的 `fetchTodos()`
   與 `scripts/daily-reminder.mjs` 的 `fetchDueTodos()` 皆從該處取得，
   不再各自寫死過濾條件
3. 該定義處需有明確註記，說明修改它會同時影響哪些呼叫端

> **已移出自動化範圍**：原本第 4 條「為 `daily-reminder.yml` 加上
> `concurrency`」改由使用者手動處理。原因：GitHub Actions 的預設
> `GITHUB_TOKEN` 沒有修改 `.github/workflows/` 的權限，push 會被拒絕。
> 要繞過需建立帶 `workflow` scope 的個人存取權杖，為了三行設定
> 交出更大的權限不划算。

---

## 明確不處理內容

- **不建立 `js/core/`、`js/modules/`、`js/registry.js` 等模組結構**，
  那已獨立列為《新項目提議－模組邊界與資料存取契約 v1》，不在本次範圍
- 不搬移既有的月曆或待辦程式碼
- 不處理 Mia 的 Pending Operation 機制未實作問題（AGENTS.md 與
  `bright-worker/index.ts` 的規範衝突）——獨立提議
- 不處理 `push_subscriptions` 可能存在重複 endpoint 的問題
  （需查生產資料庫才能確認，屬另一個獨立的重複來源）
- 不處理 `source: "ai"` 欄位缺少對應 migration 的問題
- 不修改任何 RLS policy、不執行任何 SQL
- 不修改 Mia 的 system prompt 或行為
- 不新增測試框架

---

## 驗收條件

- [ ] 搜尋整個 repo，todos 的過濾條件只出現在一個定義處
- [ ] `scripts/daily-reminder.mjs` 的查詢包含 `archived_at is null`
- [ ] `script.js` 的 `fetchTodos()` 行為與修改前完全一致
      （原本就有此過濾條件，不得因重構而改變行為）
- [ ] `node --check script.js` 與 `node --check scripts/daily-reminder.mjs`
      皆通過
- [ ] 未修改任何 `.sql` 檔案、未修改 RLS 相關內容
- [ ] 未新增任何框架、函式庫或 CDN 引用

---

## 需要使用者介入的項目

- **實機驗證**：合併後隔天早上確認提醒內容不再出現已封存的項目
  （自動化測試驗不出來，必須等實際排程跑過）
- **前端版本號**：若本次改動觸及 `script.js`，需 bump
  `index.html` 的 `?v=` 與 `sw.js` 的 `CACHE_NAME`
- PR 審查與合併
- **手動為 `.github/workflows/daily-reminder.yml` 加上 `concurrency`**
  （自動化無權限修改 workflow 檔案）：
  ```yaml
  concurrency:
    group: daily-reminder
    cancel-in-progress: false
  ```
- 查看 GitHub Actions 執行紀錄，確認 daily-reminder 每天實際跑幾次

---

## 是否擴大範圍 / SQL / Secrets / 部署

- 擴大範圍：否。共用查詢定義屬於根因修復範圍內，非新增功能
- SQL／資料庫：不涉及
- Secrets：不涉及
- 部署：不涉及
- 前端版本／Service Worker cache：**可能涉及**，見上方使用者介入項目

---

## 交給協作 AI 的限制

- 先讀 repo 根目錄的 `AGENTS.md`
- 只允許修改以下檔案，不得動其他任何檔案：
  - `scripts/daily-reminder.mjs`
  - `script.js`
  - 新增一支共用定義檔（檔名由實作決定，須放在 repo 既有結構內）
- 不得修改 `index.html`、`style.css`、`sw.js`、
  `supabase/` 底下任何檔案、任何 `.sql` 檔
- 不得修改 `.github/` 底下任何檔案（權限限制，且非本次範圍）
- 不得修改 `.pipeline/` 底下任何檔案（那是管線本身的程式）
- 若發現本規格有誤或無法執行，回報並停止，不要自行擴大範圍解決
