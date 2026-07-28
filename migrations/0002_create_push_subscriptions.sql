-- ============================================================================
-- Migration 0002：建立 push_subscriptions 資料表（Web Push 訂閱）
-- ----------------------------------------------------------------------------
-- 用途：
--   儲存瀏覽器 PushManager.subscribe() 產生的推播訂閱資訊，讓每天的
--   GitHub Actions 排程可以對這些裝置發送 Web Push 通知。
--
--   一筆訂閱＝一台裝置上的一個瀏覽器。同一個使用者可以有多筆
--   （手機、平板、桌機各一），所以這裡「不是」一對一。
--
-- 執行方式：
--   Supabase Dashboard → SQL Editor → 貼上本檔內容 → Run。
--
-- 注意：
--   - 這份 migration 只新增資料表、索引與 policy，不會動到 todos 或任何既有資料。
--   - 刻意「不」建立 DELETE policy，見下方第 4 節的說明。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) 資料表
-- ----------------------------------------------------------------------------
-- 欄位說明：
--   endpoint   推播服務端點 URL（每台裝置唯一，由瀏覽器廠商的推播服務發給）
--   p256dh     訂閱的公鑰，web-push 加密內容時要用
--   auth       訂閱的驗證密鑰，同上
--   revoked_at 取消訂閱的時間。NULL 代表「目前有效」。
--              使用者關閉開關時寫入時間戳，而不是刪除整列，
--              這樣保留了「這台裝置曾經訂閱過又關掉」的紀錄。
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz default null
);

-- ----------------------------------------------------------------------------
-- 2) endpoint 唯一
-- ----------------------------------------------------------------------------
-- 同一台裝置重複訂閱時，瀏覽器會回傳「同一個 endpoint」。
-- 加上唯一約束後，前端就能用 upsert（on conflict do update）把該列更新，
-- 而不是每次開關都新增一筆，避免同一台裝置收到重複通知。
--
-- 這個唯一約束同時會自動建立唯一索引，前端「依 endpoint 查目前狀態」
-- 的查詢也直接吃得到，不需要再另外建索引。
alter table public.push_subscriptions
  drop constraint if exists push_subscriptions_endpoint_key;
alter table public.push_subscriptions
  add constraint push_subscriptions_endpoint_key unique (endpoint);

-- ----------------------------------------------------------------------------
-- 3) 索引
-- ----------------------------------------------------------------------------
-- 查詢固定會帶 `revoked_at is null`，兩種形式：
--   a) 前端：where user_id = <目前使用者> and revoked_at is null
--   b) 排程：where revoked_at is null（跨使用者掃出所有有效訂閱）
--
-- 建成「只索引有效訂閱」的部分索引 (partial index)：
--   - 索引體積只跟「目前有效」的訂閱數成正比，取消的訂閱越多、相對越省。
--   - WHERE 條件與查詢條件一致，Postgres 才用得上這個部分索引。
--   - 索引鍵放 user_id 可服務 (a)；(b) 沒有其他過濾條件，
--     規劃器可直接掃這個部分索引取得全部有效列，一樣受益。
create index if not exists push_subscriptions_active_idx
  on public.push_subscriptions (user_id)
  where revoked_at is null;

-- ----------------------------------------------------------------------------
-- 4) Row Level Security
-- ----------------------------------------------------------------------------
-- 每個 policy 分開寫，權限邊界一眼看得出來，不用去推敲 for all 到底涵蓋什麼。
--
-- ⚠️ 刻意沒有 DELETE policy：
--   前端「關閉每日提醒」走的是 UPDATE（寫入 revoked_at），不是 DELETE。
--   真正需要刪除的情境只有一個 —— 推播回應 410/404（訂閱已失效）時
--   由 GitHub Actions 清理，那邊用 service_role 金鑰執行，
--   service_role 會繞過 RLS，本來就不需要（也不會用到）policy。
--   因此不建 DELETE policy，前端就完全沒有刪除這張表的能力。
alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subscriptions_select_own" on public.push_subscriptions;
create policy "push_subscriptions_select_own"
  on public.push_subscriptions
  for select
  using (auth.uid() = user_id);

drop policy if exists "push_subscriptions_insert_own" on public.push_subscriptions;
create policy "push_subscriptions_insert_own"
  on public.push_subscriptions
  for insert
  with check (auth.uid() = user_id);

-- UPDATE 需要同時給 using 與 with check：
--   using      決定「哪些列可以被這個使用者更新」
--   with check 決定「更新後的內容是否仍合法」
-- 少了 with check，使用者就能把別人的 user_id 寫到自己的列上（或反過來）。
drop policy if exists "push_subscriptions_update_own" on public.push_subscriptions;
create policy "push_subscriptions_update_own"
  on public.push_subscriptions
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
