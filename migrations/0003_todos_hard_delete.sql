-- 執行紀錄（2026-08-04）：
-- 實際執行時發現 production 已存在 DELETE policy「使用者只能刪除自己的待辦」，
-- 內容為 (auth.uid() = user_id)，與本檔要建立的 todos_delete_own 功能相同。
-- 因此本檔的 create policy 區塊與 existing_delete_policy_count 檢查均未執行，
-- 只執行了外鍵變更（NO ACTION → SET NULL），已驗證生效。
-- 本檔照原樣重跑會失敗，這是預期行為。
-- ============================================================================
-- Migration 0003: todos permanent deletion support
-- ============================================================================
-- This repository does not contain the production definitions for
-- public.pending_operation_items or the existing public.todos policies.
-- Before running the migration, execute only the PRE-FLIGHT block below in the
-- Supabase Dashboard SQL Editor and confirm that:
--   1. exactly one foreign key is returned;
--   2. it is pending_operation_items.todo_id -> todos, delete_action is
--      NO ACTION, and todo_id_is_not_null is false;
--   3. no DELETE policy is returned for public.todos.
--
-- Then execute the MIGRATION block. The migration repeats these checks and
-- aborts the entire transaction if production does not match the expectations.
-- It does not drop public.todos.archived_at or change existing archived rows.

-- ----------------------------------------------------------------------------
-- PRE-FLIGHT (read-only; run and review before executing the migration)
-- ----------------------------------------------------------------------------
select
  c.conname as constraint_name,
  pg_get_constraintdef(c.oid) as constraint_definition,
  case c.confdeltype
    when 'a' then 'NO ACTION'
    when 'r' then 'RESTRICT'
    when 'c' then 'CASCADE'
    when 'n' then 'SET NULL'
    when 'd' then 'SET DEFAULT'
  end as delete_action,
  a.attnotnull as todo_id_is_not_null
from pg_constraint as c
join pg_attribute as a
  on a.attrelid = c.conrelid
 and a.attnum = c.conkey[1]
where c.contype = 'f'
  and c.conrelid = 'public.pending_operation_items'::regclass
  and c.confrelid = 'public.todos'::regclass
  and array_length(c.conkey, 1) = 1
  and a.attname = 'todo_id';

select
  policyname,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'todos'
  and cmd = 'DELETE';

-- ----------------------------------------------------------------------------
-- MIGRATION (execute only after reviewing the pre-flight results)
-- ----------------------------------------------------------------------------
begin;

do $migration$
declare
  matching_constraint_count integer;
  existing_delete_policy_count integer;
  todo_id_is_not_null boolean;
  fk_name text;
  fk_definition text;
  updated_fk_definition text;
begin
  select count(*)
    into matching_constraint_count
  from pg_constraint as c
  join pg_attribute as a
    on a.attrelid = c.conrelid
   and a.attnum = c.conkey[1]
  where c.contype = 'f'
    and c.conrelid = 'public.pending_operation_items'::regclass
    and c.confrelid = 'public.todos'::regclass
    and array_length(c.conkey, 1) = 1
    and a.attname = 'todo_id'
    and c.confdeltype = 'a';

  if matching_constraint_count <> 1 then
    raise exception
      'Expected exactly one NO ACTION foreign key from pending_operation_items.todo_id to todos; found %',
      matching_constraint_count;
  end if;

  select a.attnotnull, c.conname, pg_get_constraintdef(c.oid)
    into todo_id_is_not_null, fk_name, fk_definition
  from pg_constraint as c
  join pg_attribute as a
    on a.attrelid = c.conrelid
   and a.attnum = c.conkey[1]
  where c.contype = 'f'
    and c.conrelid = 'public.pending_operation_items'::regclass
    and c.confrelid = 'public.todos'::regclass
    and array_length(c.conkey, 1) = 1
    and a.attname = 'todo_id'
    and c.confdeltype = 'a';

  if todo_id_is_not_null then
    raise exception
      'pending_operation_items.todo_id is NOT NULL; ON DELETE SET NULL cannot be applied safely';
  end if;

  select count(*)
    into existing_delete_policy_count
  from pg_policies
  where schemaname = 'public'
    and tablename = 'todos'
    and cmd = 'DELETE';

  if existing_delete_policy_count <> 0 then
    raise exception
      'Expected no existing DELETE policy on public.todos; found %',
      existing_delete_policy_count;
  end if;

  updated_fk_definition := regexp_replace(
    fk_definition,
    '^(FOREIGN KEY .* REFERENCES .*\([^)]*\))(.*)$',
    E'\\1 ON DELETE SET NULL\\2'
  );

  if updated_fk_definition = fk_definition then
    raise exception 'Could not safely add ON DELETE SET NULL to foreign key definition: %',
      fk_definition;
  end if;

  execute format(
    'alter table public.pending_operation_items drop constraint %I',
    fk_name
  );
  execute format(
    'alter table public.pending_operation_items add constraint %I %s',
    fk_name,
    updated_fk_definition
  );
end
$migration$;

create policy "todos_delete_own"
  on public.todos
  for delete
  using (auth.uid() = user_id);

commit;

-- ----------------------------------------------------------------------------
-- POST-MIGRATION VERIFICATION (read-only)
-- Expected: one SET NULL foreign key and one DELETE policy whose qual is
-- (auth.uid() = user_id).
-- ----------------------------------------------------------------------------
select
  c.conname as constraint_name,
  pg_get_constraintdef(c.oid) as constraint_definition,
  case c.confdeltype
    when 'a' then 'NO ACTION'
    when 'r' then 'RESTRICT'
    when 'c' then 'CASCADE'
    when 'n' then 'SET NULL'
    when 'd' then 'SET DEFAULT'
  end as delete_action
from pg_constraint as c
join pg_attribute as a
  on a.attrelid = c.conrelid
 and a.attnum = c.conkey[1]
where c.contype = 'f'
  and c.conrelid = 'public.pending_operation_items'::regclass
  and c.confrelid = 'public.todos'::regclass
  and array_length(c.conkey, 1) = 1
  and a.attname = 'todo_id';

select
  policyname,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'todos'
  and cmd = 'DELETE';

/*
-- ============================================================================
-- ROLLBACK (separate execution; remove this outer comment before running)
-- Restores the pre-migration state: no todos DELETE policy and NO ACTION on the
-- same foreign key. Run the post-rollback verification afterward.
-- ============================================================================
begin;

drop policy if exists "todos_delete_own" on public.todos;

do $rollback$
declare
  matching_constraint_count integer;
  fk_name text;
  fk_definition text;
  restored_fk_definition text;
begin
  select count(*)
    into matching_constraint_count
  from pg_constraint as c
  join pg_attribute as a
    on a.attrelid = c.conrelid
   and a.attnum = c.conkey[1]
  where c.contype = 'f'
    and c.conrelid = 'public.pending_operation_items'::regclass
    and c.confrelid = 'public.todos'::regclass
    and array_length(c.conkey, 1) = 1
    and a.attname = 'todo_id'
    and c.confdeltype = 'n';

  if matching_constraint_count <> 1 then
    raise exception
      'Expected exactly one SET NULL foreign key from pending_operation_items.todo_id to todos; found %',
      matching_constraint_count;
  end if;

  select c.conname, pg_get_constraintdef(c.oid)
    into fk_name, fk_definition
  from pg_constraint as c
  join pg_attribute as a
    on a.attrelid = c.conrelid
   and a.attnum = c.conkey[1]
  where c.contype = 'f'
    and c.conrelid = 'public.pending_operation_items'::regclass
    and c.confrelid = 'public.todos'::regclass
    and array_length(c.conkey, 1) = 1
    and a.attname = 'todo_id'
    and c.confdeltype = 'n';

  restored_fk_definition := replace(
    fk_definition,
    ' ON DELETE SET NULL',
    ' ON DELETE NO ACTION'
  );

  if restored_fk_definition = fk_definition then
    raise exception 'Could not safely restore ON DELETE NO ACTION in foreign key definition: %',
      fk_definition;
  end if;

  execute format(
    'alter table public.pending_operation_items drop constraint %I',
    fk_name
  );
  execute format(
    'alter table public.pending_operation_items add constraint %I %s',
    fk_name,
    restored_fk_definition
  );
end
$rollback$;

commit;

-- POST-ROLLBACK VERIFICATION (read-only)
-- Expected: one NO ACTION foreign key and no DELETE policy.
select
  c.conname as constraint_name,
  pg_get_constraintdef(c.oid) as constraint_definition,
  case c.confdeltype
    when 'a' then 'NO ACTION'
    when 'r' then 'RESTRICT'
    when 'c' then 'CASCADE'
    when 'n' then 'SET NULL'
    when 'd' then 'SET DEFAULT'
  end as delete_action
from pg_constraint as c
join pg_attribute as a
  on a.attrelid = c.conrelid
 and a.attnum = c.conkey[1]
where c.contype = 'f'
  and c.conrelid = 'public.pending_operation_items'::regclass
  and c.confrelid = 'public.todos'::regclass
  and array_length(c.conkey, 1) = 1
  and a.attname = 'todo_id';

select
  policyname,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'todos'
  and cmd = 'DELETE';
*/
