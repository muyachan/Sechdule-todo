/**
 * Todos 查詢條件的單一來源。
 *
 * 修改這些條件會同時影響前端 script.js 的 fetchTodos()，以及排程腳本
 * scripts/daily-reminder.mjs 的 fetchDueTodos()；新增或調整條件時必須一併確認
 * 兩個呼叫端的行為。
 */
const TODO_FILTERS = Object.freeze({
  active: Object.freeze({ column: "archived_at", value: "is.null" }),
  incomplete: Object.freeze({ column: "completed_at", value: "is.null" }),
  dueThrough: Object.freeze({ column: "due_date", operator: "lte" }),
});

/** 將「未封存」條件套用至 Supabase JavaScript query builder。 */
export function applyActiveTodoFilter(query) {
  return query.is(TODO_FILTERS.active.column, null);
}

/** 將每日提醒所需的 todos 條件套用至 PostgREST URLSearchParams。 */
export function applyDueTodoFilters(searchParams, todayStr) {
  searchParams.set(TODO_FILTERS.active.column, TODO_FILTERS.active.value);
  searchParams.set(TODO_FILTERS.incomplete.column, TODO_FILTERS.incomplete.value);
  searchParams.set(
    TODO_FILTERS.dueThrough.column,
    `${TODO_FILTERS.dueThrough.operator}.${todayStr}`
  );
}
