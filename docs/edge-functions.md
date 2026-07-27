# Edge Function 的部署方式

AI 助理 Mia 的後端是 Supabase Edge Function `bright-worker`。
從這次改動起，它的原始碼進了 repo，並且**由 GitHub Actions 自動部署**。

## 原始碼位置

```
supabase/
├── config.toml                       # 函式設定（例如 verify_jwt）
└── functions/
    └── bright-worker/
        └── index.ts                  # 函式本體
```

## 改動流程

1. 開 branch，改 `supabase/functions/` 底下的檔案
2. 開 PR、review
3. 合併到 `main`

合併後 `.github/workflows/deploy-functions.yml` 會自動跑 `supabase functions deploy`，
把 repo 裡的版本推上 Supabase。也可以到 GitHub 的 Actions 頁面手動觸發
（workflow_dispatch）。

只有動到 `supabase/functions/**` 或 `supabase/config.toml` 才會觸發部署，
改前端不會。

## ⚠️ 不要再直接在 Supabase Dashboard 編輯函式

**Dashboard 上的版本會被下一次部署整個覆蓋掉。**

現在 repo 是唯一的真實來源（single source of truth）。在 Dashboard 上改的東西
沒有進 repo，下次任何人合併一個跟 Edge Function 有關的 PR，那些改動就消失了，
而且不會有任何警告。要改就走上面的 PR 流程。

（Dashboard 仍然可以用來看 log、看叫用次數、測試呼叫，只是不要編輯程式碼。）

## API 金鑰不在 repo 裡

`ANTHROPIC_API_KEY` 這類密鑰存在 **Supabase 的 Function Secrets**
（Dashboard → Edge Functions → Secrets），函式在執行時用 `Deno.env.get()` 讀取。

它們**不在 repo 裡，部署也不會動到它們**——`supabase functions deploy` 只上傳程式碼，
不會覆寫、也不會清空既有的 secrets。要新增或更換金鑰，還是到 Supabase Dashboard 設定。

同理，GitHub Actions 部署用的認證（`SUPABASE_ACCESS_TOKEN`、`SUPABASE_PROJECT_REF`）
存在 GitHub Secrets，workflow 的 yml 裡沒有寫死任何值。

## verify_jwt 由設定檔決定

`supabase/config.toml`：

```toml
[functions.bright-worker]
verify_jwt = true
```

部署指令刻意**不加** `--no-verify-jwt` 之類的旗標，讓這個設定檔說了算。
要改驗證行為，改這個檔案並走 PR，不要在 workflow 的指令列上覆寫——
否則會出現「repo 裡寫 true、線上跑的卻是 false」這種對不起來的狀況。
