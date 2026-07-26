-- ============================================================================
-- Migration 0001：todos 資料表新增 archived_at（封存時間）
-- ----------------------------------------------------------------------------
-- 用途：
--   待辦事項完成後不再從資料庫刪除，改為「封存」——寫入 archived_at。
--   前端所有讀取一律帶 `archived_at is null`，因此封存後的項目不會再出現在
--   月曆圓點、當日清單與全部待辦畫面，但資料仍保留在資料庫中。
--
-- 執行方式：
--   Supabase Dashboard → SQL Editor → 貼上本檔內容 → Run。
--
-- 注意：
--   - 這份 migration 只新增欄位與索引，不會動到既有資料
--     （既有列的 archived_at 皆為 NULL，等同「未封存」，行為不變）。
--   - 不修改任何現有的 RLS policy。archived_at 只是一般欄位，
--     既有 policy 以 user_id 判斷擁有者，不受影響。
-- ============================================================================

-- 1) 新增欄位：預設 NULL 代表「未封存」。
alter table public.todos
  add column if not exists archived_at timestamptz default null;

-- 2) 索引：前端查詢固定是
--       where user_id = <目前使用者> and archived_at is null
--    因此建立「只索引未封存列」的部分索引 (partial index)：
--      - 索引體積只跟未封存的資料量成正比，封存越多、索引相對越小。
--      - WHERE 條件與查詢條件一致，Postgres 才能用上這個部分索引。
create index if not exists todos_user_id_active_idx
  on public.todos (user_id)
  where archived_at is null;
