"use strict";

/* ==========================================================================
 * 資料儲存 (Storage)
 * --------------------------------------------------------------------------
 * 待辦事項：改用 Supabase（Postgres）雲端資料庫存取，登入者的資料可跨裝置同步。
 *   - 資料表 todos 欄位：id, title, due_date, completed_at, created_at,
 *     updated_at, user_id
 *   - 每筆資料歸屬於 user_id（目前登入者），並由 Row Level Security (RLS)
 *     保證每個人只能存取自己的資料。
 *
 * 聊天紀錄：仍為 mock，暫存於 localStorage（本版本不納入雲端，維持原行為）。
 * ========================================================================== */

/* ==========================================================================
 * Supabase client 初始化
 * ========================================================================== */

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = window.APP_CONFIG;

// window.supabase 由 CDN 的 @supabase/supabase-js 提供。
const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY
);

// 目前登入的使用者（尚未登入為 null）。
let currentUser = null;

/* ==========================================================================
 * DOM 參照
 * ========================================================================== */

const authScreenEl = document.getElementById("auth-screen");
const authFormEl = document.getElementById("auth-form");
const authEmailEl = document.getElementById("auth-email");
const authPasswordEl = document.getElementById("auth-password");
const signupBtn = document.getElementById("signup-btn");
const authMessageEl = document.getElementById("auth-message");

const appMainEl = document.getElementById("app-main");
const userBarEl = document.getElementById("user-bar");
const userEmailEl = document.getElementById("user-email");
const logoutBtn = document.getElementById("logout-btn");

const todoListEl = document.getElementById("todo-list");
const todoEmptyEl = document.getElementById("todo-empty");
const todoLoadingEl = document.getElementById("todo-loading");
const todoFormEl = document.getElementById("todo-form");
const todoTitleInput = document.getElementById("todo-title");
const todoDueDateInput = document.getElementById("todo-due-date");

const chatMessagesEl = document.getElementById("chat-messages");
const chatFormEl = document.getElementById("chat-form");
const chatInputEl = document.getElementById("chat-input");
const chatFabEl = document.getElementById("chat-fab");
const chatPanelEl = document.getElementById("chat-panel");

const splashEl = document.getElementById("splash");

const drawerEl = document.getElementById("todo-drawer");
const drawerToggleEl = document.getElementById("drawer-toggle");
const drawerCloseEl = document.getElementById("drawer-close");
const drawerBackdropEl = document.getElementById("drawer-backdrop");

const calGridEl = document.getElementById("cal-grid");
const calTitleEl = document.getElementById("cal-title");
const calPrevEl = document.getElementById("cal-prev");
const calNextEl = document.getElementById("cal-next");
const calJumpEl = document.getElementById("cal-jump");
const calJumpYearEl = document.getElementById("cal-jump-year");
const calJumpMonthEl = document.getElementById("cal-jump-month");
const calJumpTodayEl = document.getElementById("cal-jump-today");

const dayTitleEl = document.getElementById("day-title");
const dayListEl = document.getElementById("day-list");
const dayEmptyEl = document.getElementById("day-empty");
const dayAddFormEl = document.getElementById("day-add-form");
const dayAddTitleEl = document.getElementById("day-add-title");

/* ==========================================================================
 * 狀態 (State)
 * ========================================================================== */

/**
 * 本地端持有的待辦事項，來源為 Supabase。
 * 欄位採前端慣用的 camelCase（dueDate/completedAt/...），
 * 讀取時由 mapRowToTodo() 從資料表的 snake_case 轉換而來。
 * @type {Array<{id:string, title:string, dueDate:string, createdAt:string, updatedAt:string, completedAt:string|null}>}
 */
let todos = [];

let editingId = null;

/* ==========================================================================
 * 工具函式
 * ========================================================================== */

function generateId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function isOverdue(dueDate) {
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  return due < startOfToday();
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatDateTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 相對時間顯示：
 *   < 1 分鐘 → 剛剛
 *   < 60 分鐘 → N 分鐘前
 *   今天（>= 60 分鐘）→ 今天 HH:MM
 *   昨天 → 昨天 HH:MM
 *   今年 → M/D HH:MM
 *   更早 → YYYY/M/D HH:MM
 */
function formatRelativeTime(dateStr) {
  const then = new Date(dateStr);
  const now = new Date();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 60) return "剛剛";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分鐘前`;

  const hhmm = then.toLocaleTimeString("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const thenStart = new Date(then);
  thenStart.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((startOfToday() - thenStart) / 86400000);

  if (dayDiff <= 0) return `今天 ${hhmm}`;
  if (dayDiff === 1) return `昨天 ${hhmm}`;
  if (then.getFullYear() === now.getFullYear()) {
    return `${then.getMonth() + 1}/${then.getDate()} ${hhmm}`;
  }
  return `${then.getFullYear()}/${then.getMonth() + 1}/${then.getDate()} ${hhmm}`;
}

/** 複製文字到剪貼簿，並在按鈕上短暫顯示「已複製」。 */
async function copyToClipboard(text, btn) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // 舊瀏覽器或非安全來源 (http) 的退回方案。
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    const original = btn.textContent;
    btn.textContent = "已複製";
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  } catch (err) {
    console.warn("複製失敗：", err);
  }
}

/** 將 Supabase 資料表的一列 (snake_case) 轉為前端使用的 todo 物件 (camelCase)。 */
function mapRowToTodo(row) {
  return {
    id: row.id,
    title: row.title,
    dueDate: row.due_date,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ==========================================================================
 * 排序（規則不變）
 *   0. 未完成事項優先，已完成事項一律沉到清單底部
 *      （已完成者之間依完成時間新到舊排序）
 *   1. 未到期事項優先
 *   2. 依截止日期由近到遠
 *   3. 相同日期依建立時間
 * ========================================================================== */
function sortTodos(list) {
  return [...list].sort((a, b) => {
    const aDone = Boolean(a.completedAt);
    const bDone = Boolean(b.completedAt);
    if (aDone !== bDone) {
      return aDone ? 1 : -1;
    }
    if (aDone && bDone) {
      return new Date(b.completedAt) - new Date(a.completedAt);
    }
    const aOverdue = isOverdue(a.dueDate);
    const bOverdue = isOverdue(b.dueDate);
    if (aOverdue !== bOverdue) {
      return aOverdue ? 1 : -1;
    }
    const dateDiff = new Date(a.dueDate) - new Date(b.dueDate);
    if (dateDiff !== 0) {
      return dateDiff;
    }
    return new Date(a.createdAt) - new Date(b.createdAt);
  });
}

/* ==========================================================================
 * 月曆 (Calendar)
 * --------------------------------------------------------------------------
 * 重要：日期一律用 "YYYY-MM-DD" 字串處理與比對，不經過 new Date(dueDate)。
 * 因為 new Date("2026-08-01") 會被解讀成 UTC 午夜，在部分時區換算回本地
 * 日期時會位移一天，月曆就會把待辦標到錯誤的格子。
 * ========================================================================== */

const WEEKDAY_COUNT = 7;
const CAL_ROWS = 6; // 固定 6 列，換月時版面高度不跳動

/** Date 物件 → "YYYY-MM-DD"（以本地時間為準）。 */
function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function todayKey() {
  return toDateKey(new Date());
}

/** "YYYY-MM-DD" → 顯示用的「M月D日（週X）」。 */
function formatDayTitle(key) {
  const [y, m, d] = key.split("-").map(Number);
  const weekday = "日一二三四五六"[new Date(y, m - 1, d).getDay()];
  return `${m}月${d}日（週${weekday}）`;
}

// 目前顯示的年月，以及選中的日期（預設今天）。
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth(); // 0-11
let selectedDateKey = todayKey();

/** 依 dueDate 把待辦分組：{ "YYYY-MM-DD": [todo, ...] }。 */
function groupTodosByDate() {
  const map = new Map();
  todos.forEach((t) => {
    if (!t.dueDate) return;
    if (!map.has(t.dueDate)) map.set(t.dueDate, []);
    map.get(t.dueDate).push(t);
  });
  return map;
}

/**
 * 產生月曆格子資料：固定 6×7＝42 格，前後補上個月／下個月的日期，
 * 維持格線完整（那些日期會用淺灰顯示）。
 */
function buildCalendarCells(year, month) {
  const firstWeekday = new Date(year, month, 1).getDay(); // 0=週日
  const cells = [];
  // 從當月 1 號往前推到該週的週日
  const start = new Date(year, month, 1 - firstWeekday);

  for (let i = 0; i < CAL_ROWS * WEEKDAY_COUNT; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({
      key: toDateKey(d),
      dayNumber: d.getDate(),
      inCurrentMonth: d.getMonth() === month && d.getFullYear() === year,
    });
  }
  return cells;
}

function renderCalendar() {
  calTitleEl.textContent = `${calYear}年${calMonth + 1}月`;

  const byDate = groupTodosByDate();
  const today = todayKey();

  calGridEl.innerHTML = "";
  buildCalendarCells(calYear, calMonth).forEach((cell) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cal-cell";
    btn.dataset.date = cell.key;
    if (!cell.inCurrentMonth) btn.classList.add("is-outside");
    if (cell.key === today) btn.classList.add("is-today");
    if (cell.key === selectedDateKey) btn.classList.add("is-selected");

    const num = document.createElement("span");
    num.className = "cal-day-num";
    num.textContent = String(cell.dayNumber);
    btn.appendChild(num);

    // 有待辦事項 → 數字下方顯示小圓點（未完成主色／已完成柔灰）
    const dayTodos = byDate.get(cell.key) || [];
    const dots = document.createElement("span");
    dots.className = "cal-dots";
    if (dayTodos.length > 0) {
      const hasOpen = dayTodos.some((t) => !t.completedAt);
      const dot = document.createElement("span");
      dot.className = "cal-dot" + (hasOpen ? "" : " is-done");
      dots.appendChild(dot);
    }
    btn.appendChild(dots);

    btn.setAttribute(
      "aria-label",
      `${cell.key}${dayTodos.length ? `，${dayTodos.length} 件待辦` : ""}`
    );
    btn.addEventListener("click", () => {
      selectedDateKey = cell.key;
      // 點到上／下個月的日期時，順勢把月曆切到那個月
      if (!cell.inCurrentMonth) {
        const [y, m] = cell.key.split("-").map(Number);
        calYear = y;
        calMonth = m - 1;
      }
      renderCalendar();
      renderDaySection();
    });

    calGridEl.appendChild(btn);
  });
}

/** 月曆下方：選中日期的待辦清單（常駐區塊）。 */
function renderDaySection() {
  dayTitleEl.textContent = formatDayTitle(selectedDateKey);

  const list = sortTodos(todos.filter((t) => t.dueDate === selectedDateKey));
  dayListEl.innerHTML = "";
  dayEmptyEl.hidden = list.length > 0;

  list.forEach((todo) => {
    const li = document.createElement("li");
    li.className = "day-item";
    if (todo.completedAt) li.classList.add("is-completed");
    li.dataset.id = todo.id;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "day-check";
    checkbox.checked = Boolean(todo.completedAt);
    checkbox.setAttribute(
      "aria-label",
      `${todo.completedAt ? "取消完成" : "標記完成"}：${todo.title}`
    );
    checkbox.addEventListener("change", () => toggleTodoCompleted(todo.id));

    const title = document.createElement("span");
    title.className = "day-item-title";
    title.textContent = todo.title;

    const del = document.createElement("button");
    del.type = "button";
    del.className = "day-delete";
    del.textContent = "✕";
    del.setAttribute("aria-label", `刪除：${todo.title}`);
    del.addEventListener("click", () => {
      if (confirm(`確定要刪除「${todo.title}」嗎？`)) deleteTodo(todo.id);
    });

    li.append(checkbox, title, del);
    dayListEl.appendChild(li);
  });
}

function changeMonth(delta) {
  const d = new Date(calYear, calMonth + delta, 1);
  calYear = d.getFullYear();
  calMonth = d.getMonth();
  renderCalendar();
}

calPrevEl.addEventListener("click", () => changeMonth(-1));
calNextEl.addEventListener("click", () => changeMonth(1));

/* ---- 快速跳轉年月 ---- */

function initCalJumpOptions() {
  const thisYear = new Date().getFullYear();
  for (let y = thisYear - 5; y <= thisYear + 5; y++) {
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = `${y}年`;
    calJumpYearEl.appendChild(opt);
  }
  for (let m = 1; m <= 12; m++) {
    const opt = document.createElement("option");
    opt.value = String(m - 1);
    opt.textContent = `${m}月`;
    calJumpMonthEl.appendChild(opt);
  }
}

function toggleCalJump(forceOpen) {
  const open = forceOpen === undefined ? calJumpEl.hidden : forceOpen;
  calJumpEl.hidden = !open;
  calTitleEl.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    calJumpYearEl.value = String(calYear);
    calJumpMonthEl.value = String(calMonth);
  }
}

calTitleEl.addEventListener("click", () => toggleCalJump());

function applyCalJump() {
  calYear = Number(calJumpYearEl.value);
  calMonth = Number(calJumpMonthEl.value);
  renderCalendar();
}

calJumpYearEl.addEventListener("change", applyCalJump);
calJumpMonthEl.addEventListener("change", applyCalJump);

calJumpTodayEl.addEventListener("click", () => {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  selectedDateKey = todayKey();
  toggleCalJump(false);
  renderCalendar();
  renderDaySection();
});

/* ---- 於選中日期新增待辦 ---- */

dayAddFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const title = dayAddTitleEl.value.trim();
  if (!title) return;
  addTodo(title, selectedDateKey); // 自動帶入選中日期作為截止日
  dayAddFormEl.reset();
});

/* ==========================================================================
 * 待辦事項資料層 (Supabase CRUD)
 * --------------------------------------------------------------------------
 * 每次異動後重新抓取整份清單再 render，確保與資料庫一致（個人待辦資料量小，
 * 這樣做最單純可靠）。
 * ========================================================================== */

async function fetchTodos() {
  if (!currentUser) return;
  todoLoadingEl.hidden = false;
  const { data, error } = await supabaseClient
    .from("todos")
    .select("*")
    // RLS 已限制只會回傳自己的資料，這裡再明確過濾一次，語意更清楚。
    .eq("user_id", currentUser.id);
  todoLoadingEl.hidden = true;

  if (error) {
    console.error("讀取待辦事項失敗：", error);
    alert(`讀取待辦事項失敗：${error.message}`);
    return;
  }
  todos = (data || []).map(mapRowToTodo);
  renderTodos();
}

async function addTodo(title, dueDate) {
  const now = new Date().toISOString();
  const { error } = await supabaseClient.from("todos").insert({
    title: title.trim(),
    due_date: dueDate,
    completed_at: null,
    created_at: now,
    updated_at: now,
    // 新增事項時，user_id 自動填入目前登入者的 id。
    user_id: currentUser.id,
  });
  if (error) {
    console.error("新增待辦事項失敗：", error);
    alert(`新增待辦事項失敗：${error.message}`);
    return;
  }
  await fetchTodos();
}

/**
 * @param {string} id
 * @param {{title?:string, dueDate?:string, completedAt?:string|null}} changes
 */
async function updateTodo(id, changes) {
  const patch = { updated_at: new Date().toISOString() };
  if ("title" in changes) patch.title = changes.title;
  if ("dueDate" in changes) patch.due_date = changes.dueDate;
  if ("completedAt" in changes) patch.completed_at = changes.completedAt;

  const { error } = await supabaseClient
    .from("todos")
    .update(patch)
    .eq("id", id);
  if (error) {
    console.error("更新待辦事項失敗：", error);
    alert(`更新待辦事項失敗：${error.message}`);
    return;
  }
  await fetchTodos();
}

async function toggleTodoCompleted(id) {
  const todo = todos.find((t) => t.id === id);
  if (!todo) return;
  await updateTodo(id, {
    completedAt: todo.completedAt ? null : new Date().toISOString(),
  });
}

async function deleteTodo(id) {
  const { error } = await supabaseClient.from("todos").delete().eq("id", id);
  if (error) {
    console.error("刪除待辦事項失敗：", error);
    alert(`刪除待辦事項失敗：${error.message}`);
    return;
  }
  await fetchTodos();
}

/* ==========================================================================
 * 待辦事項 Rendering（UI 與原本一致）
 * ========================================================================== */

/**
 * 待辦資料變動後的統一重畫入口。
 * 所有 CRUD（fetchTodos / addTodo / updateTodo / deleteTodo）都呼叫這個函式，
 * 由它扇出去更新三個會顯示待辦的畫面，確保彼此同步。
 */
function renderTodos() {
  renderTodoList(); // 抽屜裡的完整列表
  renderCalendar(); // 月曆上的小圓點
  renderDaySection(); // 月曆下方選中日期的清單
}

/** 抽屜裡的完整待辦列表（原本的 renderTodos，內容不變）。 */
function renderTodoList() {
  const sorted = sortTodos(todos);
  todoListEl.innerHTML = "";
  todoEmptyEl.hidden = sorted.length > 0 || !todoLoadingEl.hidden;

  sorted.forEach((todo) => {
    const li = document.createElement("li");
    li.className = "todo-item";
    if (todo.completedAt) {
      li.classList.add("is-completed");
    } else if (isOverdue(todo.dueDate)) {
      li.classList.add("is-overdue");
    }
    li.dataset.id = todo.id;

    if (editingId === todo.id) {
      li.appendChild(buildEditForm(todo));
    } else {
      li.appendChild(buildDisplayRow(todo));
    }

    todoListEl.appendChild(li);
  });
}

function buildDisplayRow(todo) {
  const wrapper = document.createDocumentFragment();

  const checkboxLabel = document.createElement("label");
  checkboxLabel.className = "todo-checkbox";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = Boolean(todo.completedAt);
  checkbox.setAttribute(
    "aria-label",
    `${todo.completedAt ? "取消完成" : "標記完成"}：${todo.title}`
  );
  checkbox.addEventListener("change", () => {
    toggleTodoCompleted(todo.id);
  });
  checkboxLabel.appendChild(checkbox);

  const main = document.createElement("div");
  main.className = "todo-main";

  const titleEl = document.createElement("div");
  titleEl.className = "todo-title";
  titleEl.textContent = todo.title;

  const meta = document.createElement("div");
  meta.className = "todo-meta";

  const due = document.createElement("span");
  due.className = "todo-due";
  due.textContent = `截止：${formatDate(todo.dueDate)}${
    !todo.completedAt && isOverdue(todo.dueDate) ? "（已過期）" : ""
  }`;

  const created = document.createElement("span");
  created.textContent = `建立：${formatDateTime(todo.createdAt)}`;

  meta.append(due, created);

  if (todo.completedAt) {
    const completed = document.createElement("span");
    completed.textContent = `完成：${formatDateTime(todo.completedAt)}`;
    meta.appendChild(completed);
  }

  main.append(titleEl, meta);

  const actions = document.createElement("div");
  actions.className = "todo-actions";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "btn btn-secondary btn-sm";
  editBtn.textContent = "編輯";
  editBtn.addEventListener("click", () => {
    editingId = todo.id;
    renderTodos();
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn btn-danger btn-sm";
  deleteBtn.textContent = "刪除";
  deleteBtn.addEventListener("click", () => {
    if (confirm(`確定要刪除「${todo.title}」嗎？`)) {
      deleteTodo(todo.id);
    }
  });

  actions.append(editBtn, deleteBtn);

  const container = document.createElement("div");
  container.style.display = "contents";
  container.append(checkboxLabel, main, actions);
  wrapper.appendChild(container);
  return wrapper;
}

function buildEditForm(todo) {
  const form = document.createElement("form");
  form.className = "todo-edit-form";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.required = true;
  titleInput.maxLength = 200;
  titleInput.value = todo.title;

  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.required = true;
  dateInput.value = todo.dueDate;

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "btn btn-primary btn-sm";
  saveBtn.textContent = "儲存";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn btn-secondary btn-sm";
  cancelBtn.textContent = "取消";
  cancelBtn.addEventListener("click", () => {
    editingId = null;
    renderTodos();
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const newTitle = titleInput.value.trim();
    if (!newTitle) return;
    editingId = null;
    updateTodo(todo.id, { title: newTitle, dueDate: dateInput.value });
  });

  form.append(titleInput, dateInput, saveBtn, cancelBtn);
  return form;
}

todoFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const title = todoTitleInput.value.trim();
  const dueDate = todoDueDateInput.value;
  if (!title || !dueDate) return;

  addTodo(title, dueDate);
  todoFormEl.reset();
  todoDueDateInput.value = new Date().toISOString().slice(0, 10);
  todoTitleInput.focus();
});

/* ==========================================================================
 * AI 行程規劃對話區 (Chat) —— 呼叫 Supabase Edge Function，對話歷史存 localStorage
 * ========================================================================== */

const CHAT_STORAGE_KEY = "schedule-todo:chatMessages";

// Edge Function 端點：<專案 URL>/functions/v1/bright-worker
const CHAT_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/bright-worker`;

// 每次最多送出最近幾則對話歷史給後端（控制 API 成本）。
const CHAT_HISTORY_LIMIT = 20;

// 送出中旗標：避免使用者重複送出（含按 Enter 重送）。
let isChatBusy = false;

// 送出按鈕與「思考中...」暫時泡泡的參照。
const chatSubmitBtn = chatFormEl.querySelector('button[type="submit"]');
let chatPendingBubble = null;

/** @type {Array<{id:string, role:'user'|'ai', content:string, createdAt:string}>} */
let chatMessages = loadChatFromStorage();

function loadChatFromStorage() {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.warn("讀取聊天紀錄失敗，使用空清單。", err);
    return [];
  }
}

function persistChatMessages() {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatMessages));
  } catch (err) {
    console.warn("寫入聊天紀錄失敗。", err);
  }
}

function addChatMessage(role, content, meta = {}) {
  const message = {
    id: generateId(),
    role,
    content,
    createdAt: new Date().toISOString(),
    // meta 可帶額外欄位（例如 todosChanged），一併保存與渲染。
    ...meta,
  };
  chatMessages.push(message);
  persistChatMessages();
  renderChatMessages();
  return message;
}

function scrollChatToBottom() {
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

/** 建立 AI 頭像元素。 */
function buildAvatar() {
  const avatar = document.createElement("div");
  avatar.className = "chat-avatar";
  avatar.textContent = "🤖";
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}

/** 建立一則訊息的 row（AI 訊息含頭像、複製按鈕；使用者訊息維持純文字）。 */
function buildChatRow(msg) {
  const isUser = msg.role === "user";
  const row = document.createElement("div");
  row.className = `chat-row ${isUser ? "user" : "ai"}`;

  if (!isUser) row.appendChild(buildAvatar());

  const bubble = document.createElement("div");
  bubble.className = `chat-message ${isUser ? "user" : "ai"}`;

  if (!isUser) {
    // AI 訊息右上角的「複製」按鈕（複製原始文字內容）。
    const head = document.createElement("div");
    head.className = "chat-bubble-head";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "chat-copy-btn";
    copyBtn.textContent = "複製";
    copyBtn.setAttribute("aria-label", "複製這則 AI 回覆");
    copyBtn.addEventListener("click", () => copyToClipboard(msg.content, copyBtn));
    head.appendChild(copyBtn);
    bubble.appendChild(head);
  }

  const text = document.createElement("div");
  if (isUser) {
    // 使用者訊息維持純文字（textContent，天然防 XSS）。
    text.className = "chat-text";
    text.textContent = msg.content;
  } else {
    // AI 回覆是 Markdown，渲染成 HTML 後顯示（含 XSS 防護）。
    text.className = "chat-markdown";
    text.innerHTML = renderMarkdown(msg.content);
  }
  bubble.appendChild(text);

  // AI 有動過待辦資料庫時，在訊息下方顯示一個小提示。
  if (!isUser && msg.todosChanged) {
    const notice = document.createElement("div");
    notice.className = "chat-todos-updated";
    notice.textContent = "📋 待辦事項已更新";
    bubble.appendChild(notice);
  }

  const time = document.createElement("time");
  time.className = "chat-time";
  time.setAttribute("datetime", msg.createdAt);
  time.title = formatDateTime(msg.createdAt); // 滑鼠移上去看完整時間
  time.textContent = formatRelativeTime(msg.createdAt);
  bubble.appendChild(time);

  row.appendChild(bubble);
  return row;
}

function renderChatMessages() {
  chatMessagesEl.innerHTML = "";

  if (chatMessages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "chat-empty";
    empty.textContent = "還沒有對話紀錄，輸入訊息開始跟 AI 助理聊聊你的行程吧！";
    chatMessagesEl.appendChild(empty);
    return;
  }

  chatMessages.forEach((msg) => {
    chatMessagesEl.appendChild(buildChatRow(msg));
  });

  scrollChatToBottom();
}

/** 每分鐘更新一次相對時間文字（只更新真正的訊息，不動思考中/錯誤泡泡）。 */
function refreshChatTimes() {
  chatMessagesEl
    .querySelectorAll("time.chat-time[datetime]")
    .forEach((el) => {
      el.textContent = formatRelativeTime(el.getAttribute("datetime"));
    });
}

/**
 * 將 AI 回覆的 Markdown 轉成「已消毒 (sanitized)」的 HTML。
 * - 用 marked 解析 Markdown（支援粗體、清單、表格等）。
 * - 用 DOMPurify 過濾掉可能的 XSS（script、onerror、javascript: 等）。
 * 若 CDN 尚未載入或解析失敗，退回純文字，確保畫面不會壞掉。
 * @param {string} markdown
 * @returns {string} 安全的 HTML 字串
 */
function renderMarkdown(markdown) {
  const escapeHtml = (s) =>
    s.replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  try {
    if (window.marked && window.DOMPurify) {
      const rawHtml = window.marked.parse(markdown, { breaks: true });
      return window.DOMPurify.sanitize(rawHtml);
    }
  } catch (err) {
    console.warn("Markdown 渲染失敗，退回純文字。", err);
  }
  return escapeHtml(markdown);
}

/** 整理目前所有待辦事項成為 AI 對話上下文，送給 Edge Function。 */
function getTodosContext() {
  return sortTodos(todos).map((t) => ({
    // id 一定要帶上：Edge Function 要修改/標記完成某筆待辦時，
    // 需要靠這個 id 才知道要更新資料庫裡的哪一列。
    id: t.id,
    title: t.title,
    dueDate: t.dueDate,
    isOverdue: !t.completedAt && isOverdue(t.dueDate),
    isCompleted: Boolean(t.completedAt),
  }));
}

/**
 * 將本地聊天訊息轉成 Edge Function 需要的格式。
 * 本地 role 使用 'user' / 'ai'，這裡把 'ai' 對應成 LLM 慣用的 'assistant'。
 * @param {Array<{role:'user'|'ai', content:string}>} list
 */
function toApiMessages(list) {
  return list.map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));
}

/** 建立一個帶 AI 頭像的暫時 row（給思考中 / 錯誤泡泡共用）。 */
function buildTransientAiRow(bubbleClass, textContent) {
  const row = document.createElement("div");
  row.className = "chat-row ai";
  row.appendChild(buildAvatar());
  const bubble = document.createElement("div");
  bubble.className = `chat-message ai ${bubbleClass}`;
  bubble.textContent = textContent;
  row.appendChild(bubble);
  return row;
}

/** 顯示 / 移除「思考中...」暫時泡泡（不納入 chatMessages，不會被存到 localStorage）。 */
function showChatThinking() {
  chatPendingBubble = buildTransientAiRow("chat-pending", "思考中...");
  chatMessagesEl.appendChild(chatPendingBubble);
  scrollChatToBottom();
}

function hideChatThinking() {
  if (chatPendingBubble && chatPendingBubble.parentNode) {
    chatPendingBubble.parentNode.removeChild(chatPendingBubble);
  }
  chatPendingBubble = null;
}

/** 顯示一則暫時的錯誤泡泡（不存進歷史，下次送出時會被重繪清掉）。 */
function showChatError(text) {
  chatMessagesEl.appendChild(buildTransientAiRow("chat-error", `⚠️ ${text}`));
  scrollChatToBottom();
}

function setChatBusy(busy) {
  isChatBusy = busy;
  chatSubmitBtn.disabled = busy;
  chatInputEl.disabled = busy;
}

/**
 * 呼叫 Supabase Edge Function 取得 AI 回覆。
 * @param {Array<{role:string, content:string}>} messages 對話歷史（已裁切成最近 N 則）
 * @param {Array} todosContext getTodosContext() 的結果
 * @param {string} accessToken 目前登入者的 access token
 * @returns {Promise<string>} AI 回覆文字
 */
async function callChatFunction(messages, todosContext, accessToken) {
  // 除錯用：印出實際要送給 Edge Function 的 todos payload，
  // 方便確認每筆待辦事項都有帶到 id（不是 undefined）。
  console.log("[chat] 送出的 todos payload：", todosContext);

  const res = await fetch(CHAT_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ messages, todos: todosContext }),
  });

  // 後端可能回 { reply } 或 { error }，都嘗試解析 JSON。
  let data = {};
  try {
    data = await res.json();
  } catch (_) {
    throw new Error(`伺服器回應無法解析 (${res.status})`);
  }

  if (data && data.error) {
    throw new Error(data.error);
  }
  if (!res.ok) {
    throw new Error(`伺服器錯誤 (${res.status})`);
  }
  if (!data || typeof data.reply !== "string") {
    throw new Error("伺服器回應缺少 reply 欄位");
  }
  // todosChanged 代表 AI 這次有動到待辦資料庫（新增/修改/標記完成）。
  return { reply: data.reply, todosChanged: Boolean(data.todosChanged) };
}

/**
 * 明確處理 Enter 送出，避免依賴瀏覽器對「input 內按 Enter 送出表單」的
 * 預設行為在不同瀏覽器 / 輸入法下不一致（這也是中文輸入法選字時
 * 常見「按兩次 Enter 才送出」的成因：第一次 Enter 其實是在確認選字）。
 *   - 按 Enter 時若正在輸入法選字中（isComposing），不送出，交給輸入法處理。
 *   - 按 Enter 且未在選字中 → 立即送出（一次就好）。
 *   - Shift+Enter → 不送出（目前是單行 input，本來就無法換行，這裡明確
 *     擋下即可，避免萬一被瀏覽器解讀成送出）。
 */
chatInputEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.isComposing || e.keyCode === 229) return; // 輸入法選字中，交給輸入法處理

  // 單行 input 本來就不能換行，但按 Enter（含 Shift+Enter）在單一文字
  // 欄位的表單中，瀏覽器預設行為就是送出表單，所以 Shift+Enter 這裡也要
  // 明確擋下，才不會被瀏覽器的預設行為送出。
  e.preventDefault();
  if (e.shiftKey) return; // 保留給換行，不送出

  chatFormEl.requestSubmit();
});

chatFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isChatBusy) return; // 送出中，忽略重複送出

  const message = chatInputEl.value.trim();
  if (!message) return;

  addChatMessage("user", message);
  chatFormEl.reset();

  setChatBusy(true);
  showChatThinking();

  try {
    // 取得目前登入者的 access token。
    const { data: sessionData } = await supabaseClient.auth.getSession();
    const accessToken = sessionData.session
      ? sessionData.session.access_token
      : null;
    if (!accessToken) {
      throw new Error("尚未登入或登入已過期，請重新登入。");
    }

    // 只送出最近 CHAT_HISTORY_LIMIT 則歷史（含這次的使用者訊息）以控制成本。
    const recent = chatMessages.slice(-CHAT_HISTORY_LIMIT);
    const { reply, todosChanged } = await callChatFunction(
      toApiMessages(recent),
      getTodosContext(),
      accessToken
    );

    hideChatThinking();
    // 把 todosChanged 記在訊息上，讓「📋 待辦事項已更新」提示能一起被渲染／保存。
    addChatMessage("ai", reply, { todosChanged });

    if (todosChanged) {
      // AI 剛動過資料庫，重新抓取待辦清單，讓使用者切到待辦分頁能看到最新結果。
      fetchTodos();
    }
  } catch (err) {
    hideChatThinking();
    showChatError(err.message || "發生未知錯誤，請稍後再試。");
  } finally {
    setChatBusy(false);
    chatInputEl.focus();
  }
});

/* ==========================================================================
 * 待辦事項列表抽屜的開關（全域元件）
 * --------------------------------------------------------------------------
 * 右上角 ☰ 按鈕開啟／收起；點背景遮罩、按 ✕、或按 ESC 也會收起。
 * 抽屜內的列表與表單沿用既有邏輯，這裡只負責顯示與否。
 * ========================================================================== */

function isDrawerOpen() {
  return drawerEl.classList.contains("is-open");
}

function openDrawer() {
  drawerEl.classList.add("is-open");
  drawerBackdropEl.classList.add("is-open");
  drawerToggleEl.setAttribute("aria-expanded", "true");
}

function closeDrawer() {
  drawerEl.classList.remove("is-open");
  drawerBackdropEl.classList.remove("is-open");
  drawerToggleEl.setAttribute("aria-expanded", "false");
}

drawerToggleEl.addEventListener("click", () => {
  if (isDrawerOpen()) closeDrawer();
  else openDrawer();
});
drawerCloseEl.addEventListener("click", closeDrawer);
drawerBackdropEl.addEventListener("click", closeDrawer);

/* ==========================================================================
 * 浮動 AI 助理視窗的開關（全域元件）
 * --------------------------------------------------------------------------
 * 右下角圓形浮動按鈕：點擊展開／收起聊天視窗，展開時按鈕變成 ✕。
 * 收起方式：再次點擊按鈕、點視窗外部區域、或按 ESC。
 * 這裡只負責「顯示與否」，聊天本身的邏輯完全沿用既有程式碼。
 * ========================================================================== */

function isChatPanelOpen() {
  return chatPanelEl.classList.contains("is-open");
}

function openChatPanel() {
  // 用 class 控制顯示（而非 hidden 屬性），才能做展開／收起的過渡動畫。
  chatPanelEl.classList.add("is-open");
  chatFabEl.classList.add("is-open");
  chatFabEl.textContent = "✕";
  chatFabEl.setAttribute("aria-expanded", "true");
  chatFabEl.setAttribute("aria-label", "關閉 AI 助理");
  // 展開時捲到最新訊息（原本是切換到聊天分頁時做這件事）。
  scrollChatToBottom();
  if (!chatInputEl.disabled) chatInputEl.focus();
}

function closeChatPanel() {
  chatPanelEl.classList.remove("is-open");
  chatFabEl.classList.remove("is-open");
  chatFabEl.textContent = "💬";
  chatFabEl.setAttribute("aria-expanded", "false");
  chatFabEl.setAttribute("aria-label", "開啟 AI 助理");
}

chatFabEl.addEventListener("click", () => {
  if (isChatPanelOpen()) {
    closeChatPanel();
  } else {
    openChatPanel();
  }
});

// 點聊天視窗外部區域收起（點按鈕本身交給上面的 click 處理，這裡略過）。
document.addEventListener("click", (e) => {
  if (!isChatPanelOpen()) return;
  if (chatPanelEl.contains(e.target) || chatFabEl.contains(e.target)) return;
  closeChatPanel();
});

// ESC 收起浮層（聊天視窗、列表抽屜、年月跳轉選單）。
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (isChatPanelOpen()) closeChatPanel();
  if (isDrawerOpen()) closeDrawer();
  if (!calJumpEl.hidden) toggleCalJump(false);
});

/* ==========================================================================
 * 認證 (Auth)
 * ========================================================================== */

function showAuthMessage(text, isError) {
  authMessageEl.hidden = false;
  authMessageEl.textContent = text;
  authMessageEl.classList.toggle("is-error", Boolean(isError));
}

function clearAuthMessage() {
  authMessageEl.hidden = true;
  authMessageEl.textContent = "";
}

/** 依登入狀態切換顯示「登入畫面」或「主應用程式」。 */
function renderAuthState(user) {
  currentUser = user;
  const loggedIn = Boolean(user);

  authScreenEl.hidden = loggedIn;
  appMainEl.hidden = !loggedIn;
  userBarEl.hidden = !loggedIn;

  if (loggedIn) {
    userEmailEl.textContent = user.email || "";
    todoDueDateInput.value = new Date().toISOString().slice(0, 10);
    renderChatMessages();
    fetchTodos();
  } else {
    // 登出後清掉畫面上的資料，避免殘留，並收起所有浮層。
    todos = [];
    todoListEl.innerHTML = "";
    todoEmptyEl.hidden = true;
    calGridEl.innerHTML = "";
    dayListEl.innerHTML = "";
    closeChatPanel();
    closeDrawer();
    toggleCalJump(false);
  }

  // 登入狀態已確定、畫面也備妥，可以收掉啟動畫面了。
  hideSplash();
}

/**
 * 明確控制 Email → 密碼 的 Tab 順序。
 * 瀏覽器原生 Tab 順序在乾淨環境下其實是對的（Email → 密碼 → 登入），
 * 但實務上很常見的狀況是：Email 欄位顯示瀏覽器記住的自動填入建議清單時，
 * 按 Tab 會被瀏覽器攔截去選取建議選項，而不是移動焦點到下一個欄位。
 * 這裡直接在按下 Tab（不含 Shift）時強制把焦點移到密碼欄位，
 * 不管瀏覽器的自動填入下拉選單當下是否顯示，行為都一致可預期。
 */
authEmailEl.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !e.shiftKey) {
    e.preventDefault();
    authPasswordEl.focus();
  }
});

// 登入
authFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAuthMessage();
  const email = authEmailEl.value.trim();
  const password = authPasswordEl.value;

  const { error } = await supabaseClient.auth.signInWithPassword({
    email,
    password,
  });
  if (error) {
    showAuthMessage(`登入失敗：${error.message}`, true);
  }
  // 成功的話由 onAuthStateChange 接手切換畫面。
});

// 註冊
signupBtn.addEventListener("click", async () => {
  clearAuthMessage();
  const email = authEmailEl.value.trim();
  const password = authPasswordEl.value;
  if (!email || password.length < 6) {
    showAuthMessage("請輸入 email 並使用至少 6 個字元的密碼。", true);
    return;
  }

  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
  });
  if (error) {
    showAuthMessage(`註冊失敗：${error.message}`, true);
    return;
  }
  // 若專案開啟了 email 驗證，signUp 後不會馬上有 session。
  if (data.user && !data.session) {
    showAuthMessage("註冊成功！請至信箱點擊驗證連結後再登入。", false);
  }
});

// 登出
logoutBtn.addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  // 由 onAuthStateChange 接手切換畫面。
});

/* ==========================================================================
 * 啟動畫面 (Splash)
 * ========================================================================== */

let splashHidden = false;

/** 淡出並移除啟動畫面（重複呼叫安全）。 */
function hideSplash() {
  if (splashHidden || !splashEl) return;
  splashHidden = true;
  splashEl.classList.add("is-hiding");
  // 等淡出動畫跑完再從版面移除，避免它蓋住底下的操作。
  setTimeout(() => splashEl.remove(), 400);
}

/* ==========================================================================
 * 初始化 (Init)
 * ========================================================================== */

async function init() {
  // 月曆先畫出來（即使還沒有資料），讓啟動畫面淡出後就有完整版面。
  initCalJumpOptions();
  renderCalendar();
  renderDaySection();

  // 每分鐘更新一次聊天訊息的相對時間顯示。
  setInterval(refreshChatTimes, 60000);

  // 保險：萬一 Supabase 初始化卡住或出錯，也不要讓啟動畫面永遠蓋著整頁。
  setTimeout(hideSplash, 5000);

  // 監聽登入狀態變化（登入、登出、token 更新都會觸發）。
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    renderAuthState(session ? session.user : null);
  });

  // 檢查是否已有登入 session（重新整理後保持登入）。
  const { data } = await supabaseClient.auth.getSession();
  renderAuthState(data.session ? data.session.user : null);
}

init();
