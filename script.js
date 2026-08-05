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

const todoListEl = document.getElementById("todo-list");
const todoEmptyEl = document.getElementById("todo-empty");
const todoLoadingEl = document.getElementById("todo-loading");

const chatMessagesEl = document.getElementById("chat-messages");
const chatFormEl = document.getElementById("chat-form");
const chatInputEl = document.getElementById("chat-input");
const chatFabEl = document.getElementById("chat-fab");
const chatPanelEl = document.getElementById("chat-panel");
const chatTypingEl = document.getElementById("chat-typing");

const splashEl = document.getElementById("splash");

const drawerEl = document.getElementById("todo-drawer");
const drawerToggleEl = document.getElementById("drawer-toggle");
const drawerCloseEl = document.getElementById("drawer-close");
const drawerBackdropEl = document.getElementById("drawer-backdrop");

const pushToggleEl = document.getElementById("push-toggle");
const pushStatusEl = document.getElementById("push-status");
const pushIosHintEl = document.getElementById("push-ios-hint");

const calendarViewEl = document.getElementById("calendar-view");
const todosViewEl = document.getElementById("todos-view");
const bottomNavEl = document.getElementById("bottom-nav");
const navCalendarEl = document.getElementById("nav-calendar");
const navNotesEl = document.getElementById("nav-notes");
const navTodosEl = document.getElementById("nav-todos");
const navDarkEl = document.getElementById("nav-dark");
const navLogoutEl = document.getElementById("nav-logout");
const toastEl = document.getElementById("toast");

const calGridEl = document.getElementById("cal-grid");
const calTitleEl = document.getElementById("cal-title");
const calPrevEl = document.getElementById("cal-prev");
const calNextEl = document.getElementById("cal-next");
const calJumpEl = document.getElementById("cal-jump");
const calJumpBackdropEl = document.getElementById("cal-jump-backdrop");
const calJumpCloseEl = document.getElementById("cal-jump-close");
const calJumpYearLabelEl = document.getElementById("cal-jump-year-label");
const calJumpYearPrevEl = document.getElementById("cal-jump-year-prev");
const calJumpYearNextEl = document.getElementById("cal-jump-year-next");
const calJumpMonthsEl = document.getElementById("cal-jump-months");
const calJumpTodayEl = document.getElementById("cal-jump-today");

const dayTitleEl = document.getElementById("day-title");
const dayListEl = document.getElementById("day-list");
const dayEmptyEl = document.getElementById("day-empty");
const dayAddBtnEl = document.getElementById("day-add-btn");

const addTodoModalEl = document.getElementById("add-todo-modal");
const addTodoBackdropEl = document.getElementById("add-todo-backdrop");
const addTodoCloseEl = document.getElementById("add-todo-close");
const addTodoFormEl = document.getElementById("add-todo-form");
const addTodoTitleEl = document.getElementById("add-todo-title");
const addTodoDateEl = document.getElementById("add-todo-date");

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

/** 將 Supabase 資料表的一列 (snake_case) 轉為前端使用的 todo 物件 (camelCase)。 */
function mapRowToTodo(row) {
  return {
    id: row.id,
    title: row.title,
    dueDate: row.due_date,
    completedAt: row.completed_at,
    archivedAt: row.archived_at,
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

/**
 * 換月／換年時讓整片日期格淡入（動畫本身在 CSS 的 .is-switching）。
 * 先移除再強制 reflow 才重新加上，連續點上/下個月時動畫才會重播。
 */
function playCalGridSwitch() {
  calGridEl.classList.remove("is-switching");
  void calGridEl.offsetWidth;
  calGridEl.classList.add("is-switching");
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

  // 與待辦事項一覽同一套順序：勾選後留在原位，不因為倒數中就掉到底部。
  const list = sortForDisplay(todos.filter((t) => t.dueDate === selectedDateKey));
  dayListEl.innerHTML = "";
  dayEmptyEl.hidden = list.length > 0;

  list.forEach((todo) => {
    const li = document.createElement("li");
    li.className = "day-item";
    // 與全部待辦畫面一致：倒數封存中維持完成樣式。
    if (todo.completedAt || isPendingArchive(todo.id)) {
      li.classList.add("is-completed");
    }
    li.dataset.id = todo.id;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "day-check";
    checkbox.checked = Boolean(todo.completedAt);
    checkbox.disabled = isPendingDelete(todo.id);
    checkbox.setAttribute(
      "aria-label",
      `${todo.completedAt ? "取消完成" : "標記完成"}：${todo.title}`
    );
    // 與全部待辦畫面共用同一套勾選→倒數→封存邏輯。
    checkbox.addEventListener("change", (e) =>
      handleToggleComplete(todo.id, e.target.checked)
    );

    const main = document.createElement("div");
    main.className = "day-item-main";

    const title = document.createElement("span");
    title.className = "day-item-title";
    title.textContent = todo.title;
    main.appendChild(title);
    if (isPendingArchive(todo.id)) main.appendChild(buildUndoBar(todo.id));
    if (isPendingDelete(todo.id)) {
      main.appendChild(buildUndoBar(todo.id, "已刪除", undoDelete));
    }

    const archiveBtn = document.createElement("button");
    archiveBtn.type = "button";
    archiveBtn.className = "day-delete";
    archiveBtn.textContent = "✕";
    archiveBtn.disabled = isPendingArchive(todo.id) || isPendingDelete(todo.id);
    archiveBtn.setAttribute("aria-label", `永久刪除：${todo.title}`);
    archiveBtn.title = "永久刪除";
    archiveBtn.addEventListener("click", () => startDeleteCountdown(todo.id));

    li.append(checkbox, main, archiveBtn);
    dayListEl.appendChild(li);
  });
}

function changeMonth(delta) {
  const d = new Date(calYear, calMonth + delta, 1);
  calYear = d.getFullYear();
  calMonth = d.getMonth();
  renderCalendar();
  playCalGridSwitch();
}

calPrevEl.addEventListener("click", () => changeMonth(-1));
calNextEl.addEventListener("click", () => changeMonth(1));

/* ==========================================================================
 * 年月選擇浮層（全域元件）
 * --------------------------------------------------------------------------
 * 點月曆標題開啟：年份用左右箭頭切換、月份用 3×4 九宮格點選，
 * 選定月份後自動關閉並跳轉。開關慣例與側邊抽屜一致（.is-open + 遮罩 + ESC）。
 * ========================================================================== */

// 浮層內「正在瀏覽」的年份。與 calYear 分開，這樣切年份時
// 月曆不會跟著跳動，要等使用者點了月份才真正套用。
let calJumpYear = calYear;

function isCalJumpOpen() {
  return calJumpEl.classList.contains("is-open");
}

function openCalJump() {
  calJumpYear = calYear; // 每次開啟都從目前顯示的年份開始
  renderCalJump();
  calJumpEl.classList.add("is-open");
  calJumpBackdropEl.classList.add("is-open");
  calTitleEl.setAttribute("aria-expanded", "true");
}

function closeCalJump() {
  calJumpEl.classList.remove("is-open");
  calJumpBackdropEl.classList.remove("is-open");
  calTitleEl.setAttribute("aria-expanded", "false");
}

/** 畫出年份標題與 12 個月份格子（3 欄 × 4 列）。 */
function renderCalJump() {
  calJumpYearLabelEl.textContent = `${calJumpYear}年`;

  calJumpMonthsEl.innerHTML = "";
  for (let m = 0; m < 12; m++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cal-jump-month";
    btn.textContent = `${m + 1}月`;
    // 標出目前月曆所在的年月
    if (calJumpYear === calYear && m === calMonth) {
      btn.classList.add("is-current");
      btn.setAttribute("aria-current", "true");
    }
    btn.addEventListener("click", () => {
      calYear = calJumpYear;
      calMonth = m;
      closeCalJump(); // 選定後自動關閉
      renderCalendar();
      playCalGridSwitch();
    });
    calJumpMonthsEl.appendChild(btn);
  }
}

function changeCalJumpYear(delta) {
  calJumpYear += delta;
  renderCalJump();
}

calTitleEl.addEventListener("click", () => {
  if (isCalJumpOpen()) closeCalJump();
  else openCalJump();
});
calJumpCloseEl.addEventListener("click", closeCalJump);
calJumpBackdropEl.addEventListener("click", closeCalJump);
calJumpYearPrevEl.addEventListener("click", () => changeCalJumpYear(-1));
calJumpYearNextEl.addEventListener("click", () => changeCalJumpYear(1));

calJumpTodayEl.addEventListener("click", () => {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  selectedDateKey = todayKey();
  closeCalJump();
  renderCalendar();
  playCalGridSwitch();
  renderDaySection();
});

/* ==========================================================================
 * 新增待辦 modal（全域元件）
 * --------------------------------------------------------------------------
 * 取代原本常駐在當日清單下方的輸入欄位。開啟時日期自動帶入目前選中的日期。
 * ========================================================================== */

function isAddTodoOpen() {
  return addTodoModalEl.classList.contains("is-open");
}

function openAddTodo() {
  addTodoFormEl.reset();
  // 沿用原本「自動帶入選中日期」的行為。
  addTodoDateEl.value = selectedDateKey;
  addTodoModalEl.classList.add("is-open");
  addTodoBackdropEl.classList.add("is-open");
  dayAddBtnEl.setAttribute("aria-expanded", "true");
  // 刻意不自動 focus 輸入框：與 PR #19 對聊天輸入框的處理一致，
  // 手機上自動 focus 會立刻喚起鍵盤、把畫面往上推，體驗較差。
}

function closeAddTodo() {
  addTodoModalEl.classList.remove("is-open");
  addTodoBackdropEl.classList.remove("is-open");
  dayAddBtnEl.setAttribute("aria-expanded", "false");
}

dayAddBtnEl.addEventListener("click", openAddTodo);
addTodoCloseEl.addEventListener("click", closeAddTodo);
addTodoBackdropEl.addEventListener("click", closeAddTodo);

addTodoFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const title = addTodoTitleEl.value.trim();
  const dueDate = addTodoDateEl.value;
  if (!title || !dueDate) return;
  closeAddTodo();
  addTodo(title, dueDate); // 內含 fetchTodos() → renderTodos() 單一入口
});

/* ==========================================================================
 * 待辦事項資料層 (Supabase CRUD)
 * --------------------------------------------------------------------------
 * 每次異動後重新抓取整份清單再 render，確保與資料庫一致（個人待辦資料量小，
 * 這樣做最單純可靠）。
 * ========================================================================== */

/**
 * 讀取待辦事項。
 *
 * 這是全app唯一的 todos 讀取點；共用過濾條件定義在
 * scripts/todo-query-filters.js，
 * 月曆圓點／當日清單／全部待辦畫面三處都吃同一份 todos 陣列，
 * 不需要（也不應該）各自再加條件。
 *
 * @param {{skipBackfill?: boolean}} [options]
 */
async function fetchTodos(options = {}) {
  if (!currentUser) return;
  todoLoadingEl.hidden = false;
  const { applyActiveTodoFilter } = await import("./scripts/todo-query-filters.js");
  const query = supabaseClient
    .from("todos")
    .select("*")
    // RLS 已限制只會回傳自己的資料，這裡再明確過濾一次，語意更清楚。
    .eq("user_id", currentUser.id);
  // 已封存的項目不再顯示（資料仍保留在資料庫中）。
  const { data, error } = await applyActiveTodoFilter(query);
  todoLoadingEl.hidden = true;

  if (error) {
    console.error("讀取待辦事項失敗：", error);
    alert(`讀取待辦事項失敗：${error.message}`);
    return;
  }
  todos = (data || []).map(mapRowToTodo);

  if (!options.skipBackfill) {
    const backfilled = await backfillOrphanCompleted();
    // 有補寫的話資料已變動，重新抓一次；帶 skipBackfill 避免無限遞迴
    //（補寫後那些列的 archived_at 已非 null，下一次查詢就不會再回傳它們）。
    if (backfilled) {
      await fetchTodos({ skipBackfill: true });
      return;
    }
  }

  renderTodos();
}

/**
 * 補寫「已完成但沒有 archived_at」的孤兒項目。
 *
 * 會出現這種狀態的情境：
 *   - 上次勾選後 3 秒封存計時還沒到就關掉 App。
 *   - AI 助理（Edge Function）直接把項目標記完成，沒有經過前端的封存流程。
 * 這類項目載入時直接補寫 archived_at、不播動畫。
 *
 * 正在倒數中的項目會被排除，否則重新整理前的暫存狀態會被誤判成孤兒。
 *
 * @returns {Promise<boolean>} 是否有補寫任何資料
 */
async function backfillOrphanCompleted() {
  const orphanIds = todos
    .filter(
      (t) => t.completedAt && !t.archivedAt && !pendingArchive.has(t.id)
    )
    .map((t) => t.id);
  if (orphanIds.length === 0) return false;

  const now = new Date().toISOString();
  const { error } = await supabaseClient
    .from("todos")
    .update({ archived_at: now, updated_at: now })
    .in("id", orphanIds);
  if (error) {
    console.error("補寫封存時間失敗：", error);
    return false;
  }
  return true;
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

/**
 * 封存待辦事項（寫入 archived_at）。
 * 取代原本的 DELETE：資料一律保留在資料庫，只是不再被前端查詢到。
 */
async function archiveTodo(id) {
  const now = new Date().toISOString();
  const { error } = await supabaseClient
    .from("todos")
    .update({ archived_at: now, updated_at: now })
    .eq("id", id);
  if (error) {
    console.error("封存待辦事項失敗：", error);
    alert(`封存待辦事項失敗：${error.message}`);
    return;
  }
  await fetchTodos();
}

/**
 * 永久刪除待辦事項，並確認資料庫實際刪除恰好一列。
 * DELETE policy 或其他 RLS 條件擋下請求時，PostgREST 可能不回傳 error，
 * 因此必須用 select() 的回傳列數辨識靜默失敗。
 *
 * @returns {Promise<boolean>} 是否成功刪除一列
 */
async function deleteTodo(id) {
  const { data, error } = await supabaseClient
    .from("todos")
    .delete()
    .eq("id", id)
    .eq("user_id", currentUser.id)
    .select("id");

  if (error) {
    console.error("永久刪除待辦事項失敗：", error);
    alert(`永久刪除待辦事項失敗：${error.message}`);
    await fetchTodos();
    return false;
  }
  if (!data || data.length !== 1) {
    const affectedRows = data?.length ?? 0;
    console.error(`永久刪除待辦事項失敗：預期刪除 1 列，實際刪除 ${affectedRows} 列`);
    alert("永久刪除待辦事項失敗：找不到可刪除的待辦，請重新整理後再試。");
    await fetchTodos();
    return false;
  }

  await fetchTodos();
  return true;
}

/* ===========================================================================
 * X → 3 秒後永久刪除（含撤銷）
 * ========================================================================== */

/** @type {Map<string, {timerId:number}>} 正在倒數永久刪除的項目 */
const pendingDelete = new Map();

function isPendingDelete(id) {
  return pendingDelete.has(id);
}

/** 按 X 後只啟動倒數；倒數結束前不送出 DELETE。 */
function startDeleteCountdown(id) {
  if (isPendingArchive(id) || isPendingDelete(id)) return;

  const timerId = setTimeout(() => {
    pendingDelete.delete(id);
    document
      .querySelectorAll(`[data-id="${CSS.escape(id)}"]`)
      .forEach((el) => el.classList.add("is-archiving"));

    setTimeout(() => deleteTodo(id), ARCHIVE_ANIM_MS);
  }, ARCHIVE_DELAY_MS);

  pendingDelete.set(id, { timerId });
  renderTodos();
}

/** 撤銷 X 操作：只取消本機倒數，不送出任何資料庫請求。 */
function undoDelete(id) {
  const pending = pendingDelete.get(id);
  if (!pending) return;
  clearTimeout(pending.timerId);
  pendingDelete.delete(id);
  renderTodos();
}

/* ==========================================================================
 * 勾選 → 3 秒後自動封存（含撤銷）
 * --------------------------------------------------------------------------
 * 流程：勾選 → 立刻寫入完成狀態 → 該列套用完成樣式 → 3 秒後寫入 archived_at
 *       → 播消失動畫 → 移除該列。這 3 秒內該列顯示「已完成 · 撤銷」。
 *
 * 關鍵：倒數狀態存在這個 Map（DOM 之外），不存在列元素上。
 * renderTodos() 會整份重畫列表，若狀態放在 DOM 上就會隨重畫消失、
 * 計時也可能被重設；放在 Map 裡，重畫時只要查 Map 就能把該列還原成
 * 「已完成＋撤銷」的樣子，計時器本身完全不受重畫影響。
 *
 * 月曆下方的當日清單與全部待辦畫面共用這一套邏輯（見 handleToggleComplete）。
 * ========================================================================== */

/** 封存倒數秒數。 */
const ARCHIVE_DELAY_MS = 3000;
/** 消失動畫時間，需與 style.css 的 .is-archiving 動畫長度一致。 */
const ARCHIVE_ANIM_MS = 250;

/** @type {Map<string, {timerId:number}>} 正在倒數封存的項目 id → 計時器 */
const pendingArchive = new Map();

/** 該項目是否正在封存倒數中。 */
function isPendingArchive(id) {
  return pendingArchive.has(id);
}

/** 開始倒數：3 秒後播消失動畫並寫入 archived_at。 */
function startArchiveCountdown(id) {
  cancelArchiveCountdown(id); // 保險：不要重複計時

  const timerId = setTimeout(async () => {
    // 先播消失動畫（可能同時存在於兩個清單，兩邊都要播）。
    document
      .querySelectorAll(`[data-id="${CSS.escape(id)}"]`)
      .forEach((el) => el.classList.add("is-archiving"));

    setTimeout(async () => {
      pendingArchive.delete(id);
      await archiveTodo(id); // 內含 fetchTodos()，列會自然從資料中消失
    }, ARCHIVE_ANIM_MS);
  }, ARCHIVE_DELAY_MS);

  pendingArchive.set(id, { timerId });
}

/** 取消倒數（撤銷、或取消勾選時）。 */
function cancelArchiveCountdown(id) {
  const pending = pendingArchive.get(id);
  if (!pending) return;
  clearTimeout(pending.timerId);
  pendingArchive.delete(id);
}

/**
 * 勾選框變動的共用處理：全部待辦畫面與當日清單都走這裡。
 * @param {string} id
 * @param {boolean} checked
 */
async function handleToggleComplete(id, checked) {
  if (checked) {
    // 先登記倒數，再送出更新：更新完成後會觸發 renderTodos()，
    // 那時必須已經查得到這筆倒數狀態，該列才會畫成「已完成＋撤銷」。
    startArchiveCountdown(id);
    await updateTodo(id, { completedAt: new Date().toISOString() });
  } else {
    cancelArchiveCountdown(id);
    await updateTodo(id, { completedAt: null });
  }
}

/** 撤銷：取消倒數並還原成未完成。 */
async function undoComplete(id) {
  cancelArchiveCountdown(id);
  await updateTodo(id, { completedAt: null });
}

/** 建立「已完成 · 撤銷」小列（倒數中顯示）。 */
function buildUndoBar(id, labelText = "已完成", undoHandler = undoComplete) {
  const bar = document.createElement("div");
  bar.className = "undo-bar";

  const label = document.createElement("span");
  label.className = "undo-label";
  label.textContent = labelText;

  const sep = document.createElement("span");
  sep.className = "undo-sep";
  sep.textContent = "·";
  sep.setAttribute("aria-hidden", "true");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "undo-btn";
  btn.textContent = "撤銷";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    undoHandler(id);
  });

  bar.append(label, sep, btn);
  return bar;
}

/* ==========================================================================
 * 就地編輯（點標題文字直接改字）
 * --------------------------------------------------------------------------
 * 狀態放在模組層級、DOM 之外，理由與上面的 pendingArchive 完全一樣：
 * renderTodos() 會把整份列表重畫，狀態若掛在 DOM 上就會隨重畫消失。
 * 這裡除了「哪一列在編輯」之外，還要記住「目前輸入到什麼」與「游標在哪」，
 * 否則編輯途中若有任何重繪（例如另一列倒數結束觸發 fetchTodos），
 * 使用者打到一半的字和游標位置就會被洗掉。
 *
 * 只改標題。截止日期是唯讀的，這裡刻意不提供任何日期編輯入口。
 * ========================================================================== */

/** 正在就地編輯的待辦 id（沒有就是 null）。 */
let inlineEditId = null;
/** 編輯中的即時文字（不是 todo.title，那是還沒儲存的內容）。 */
let inlineEditValue = "";
/** 編輯中的游標／選取範圍 {start, end}。 */
let inlineEditCaret = null;
/**
 * 重繪進行中的旗標。
 * 重畫列表時舊的 input 會被移除，瀏覽器會對它送出 blur —— 那不是使用者
 * 主動失焦，不能當成「儲存」。用這個旗標把重繪期間的 blur 擋掉。
 */
let isRerendering = false;

function isInlineEditing(id) {
  return inlineEditId === id;
}

function startInlineEdit(todo) {
  // 倒數封存中不進編輯，避免兩種暫存狀態打架。
  if (isPendingArchive(todo.id)) return;
  inlineEditId = todo.id;
  inlineEditValue = todo.title;
  inlineEditCaret = { start: todo.title.length, end: todo.title.length };
  renderTodos();
}

function clearInlineEdit() {
  inlineEditId = null;
  inlineEditValue = "";
  inlineEditCaret = null;
}

/** ESC：捨棄編輯內容，還原成原本的標題。 */
function cancelInlineEdit() {
  if (!inlineEditId) return;
  clearInlineEdit();
  renderTodos();
}

/**
 * Enter 或失焦：儲存。
 * 內容沒變、或被清成空白時一律視同取消（不允許把標題存成空字串）。
 */
async function commitInlineEdit() {
  if (!inlineEditId) return;
  const id = inlineEditId;
  const value = inlineEditValue.trim();
  const todo = todos.find((t) => t.id === id);
  clearInlineEdit();

  if (!todo || !value || value === todo.title) {
    renderTodos();
    return;
  }
  await updateTodo(id, { title: value }); // 內含 fetchTodos() → renderTodos()
}

/** 建立取代標題文字的編輯框，事件行為：Enter 存、ESC 取消、失焦存。 */
function buildInlineEditInput(todo) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "todo-title-input";
  input.maxLength = 200;
  input.value = inlineEditValue;
  input.setAttribute("aria-label", `編輯待辦標題：${todo.title}`);

  const captureCaret = () => {
    inlineEditCaret = {
      start: input.selectionStart,
      end: input.selectionEnd,
    };
  };

  input.addEventListener("input", () => {
    inlineEditValue = input.value;
    captureCaret();
  });
  // 方向鍵、點擊、拖曳選取都會移動游標，一併記錄，重繪後才回得到原位。
  input.addEventListener("keyup", captureCaret);
  input.addEventListener("click", captureCaret);
  input.addEventListener("select", captureCaret);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // 這個 ESC 是「取消編輯」，不要再冒泡到全域的收起浮層處理，
      // 否則會順手把聊天視窗／抽屜一起關掉。
      e.stopPropagation();
      cancelInlineEdit();
      return;
    }
    if (e.key !== "Enter") return;
    // 中文輸入法選字中的 Enter 是「確認選字」，不能當成儲存。
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    commitInlineEdit();
  });

  input.addEventListener("blur", () => {
    // 重繪造成的 blur 不算數（見 isRerendering 的說明）。
    if (isRerendering || !input.isConnected) return;
    commitInlineEdit();
  });

  return input;
}

/**
 * 重繪後把焦點與游標放回編輯框。
 * 一定要等元素進了文件才做得到，所以統一在 renderTodos() 的最後執行，
 * 而不是在建立 input 的當下。
 */
function restoreInlineEditFocus() {
  if (!inlineEditId) return;
  const input = todoListEl.querySelector(".todo-title-input");
  if (!input) return;
  if (document.activeElement !== input) input.focus();
  if (inlineEditCaret) {
    input.setSelectionRange(inlineEditCaret.start, inlineEditCaret.end);
  }
}

/* ==========================================================================
 * 待辦事項 Rendering（UI 與原本一致）
 * ========================================================================== */

/**
 * 排序時把「正在倒數封存」的項目當作還沒完成，讓它勾選後留在原位，
 * 不會立刻掉到清單底部——3 秒後本來就要消失了，中途再跳一次位置只會
 * 讓人找不到「撤銷」。
 *
 * sortTodos() 的規則本身完全沒有改動：這裡只是餵給它一份把 completedAt
 * 遮蔽掉的副本用來決定順序，最後回傳的仍是原本的 todo 物件
 *（所以 checkbox 的勾選狀態、完成樣式都還是讀得到真實的 completedAt）。
 */
function sortForDisplay(list) {
  const masked = list.map((t) =>
    isPendingArchive(t.id) ? { ...t, completedAt: null } : t
  );
  const byId = new Map(list.map((t) => [t.id, t]));
  return sortTodos(masked).map((t) => byId.get(t.id));
}

/**
 * 待辦資料變動後的統一重畫入口。
 * 所有 CRUD（fetchTodos / addTodo / updateTodo / archiveTodo / deleteTodo）都呼叫這個函式，
 * 由它扇出去更新三個會顯示待辦的畫面，確保彼此同步。
 */
function renderTodos() {
  // 重繪期間移除舊的編輯框會觸發 blur，要先立旗標把它擋掉，
  // 否則每次重畫都會被誤判成「使用者失焦 → 儲存並結束編輯」。
  isRerendering = true;
  renderTodoList(); // #todos-view 全螢幕檢視裡的完整列表
  renderCalendar(); // 月曆上的小圓點
  renderDaySection(); // 月曆下方選中日期的清單
  isRerendering = false;
  // 新的編輯框已經在文件裡了，把焦點與游標放回去。
  restoreInlineEditFocus();
}

/**
 * 完整待辦列表。原本渲染在抽屜裡，列表移到 #todos-view 後，
 * 因為容器 ID（#todo-list / #todo-empty / #todo-loading）沿用未變，
 * 這個函式不需要改動就自動指向新的容器，維持單一重繪入口。
 */
function renderTodoList() {
  const sorted = sortForDisplay(todos);
  todoListEl.innerHTML = "";
  todoEmptyEl.hidden = sorted.length > 0 || !todoLoadingEl.hidden;

  sorted.forEach((todo) => {
    const li = document.createElement("li");
    li.className = "todo-item";
    // 倒數封存中的項目一律維持完成樣式，避免重畫時閃回未完成的樣子。
    if (todo.completedAt || isPendingArchive(todo.id)) {
      li.classList.add("is-completed");
    } else if (isOverdue(todo.dueDate)) {
      li.classList.add("is-overdue");
    }
    if (isInlineEditing(todo.id)) li.classList.add("is-editing");
    li.dataset.id = todo.id;

    li.appendChild(buildDisplayRow(todo));
    todoListEl.appendChild(li);
  });
}

/**
 * 待辦事項一覽的一列：「勾選框 ｜ 標題＋截止日期 ｜ ✕」。
 *
 * 標題點下去就地變成輸入框（不開 modal）；截止日期顯示在標題下方第二行，
 * 是唯讀的，沒有任何編輯入口。✕ 會在 3 秒撤銷視窗後永久刪除。
 */
function buildDisplayRow(todo) {
  const wrapper = document.createDocumentFragment();
  const pending = isPendingArchive(todo.id);
  const editing = isInlineEditing(todo.id);

  const checkboxLabel = document.createElement("label");
  checkboxLabel.className = "todo-checkbox";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = Boolean(todo.completedAt);
  // 編輯中不可勾選：避免「改字」與「完成→倒數封存」兩件事同時發生。
  checkbox.disabled = editing || isPendingDelete(todo.id);
  checkbox.setAttribute(
    "aria-label",
    `${todo.completedAt ? "取消完成" : "標記完成"}：${todo.title}`
  );
  checkbox.addEventListener("change", (e) => {
    handleToggleComplete(todo.id, e.target.checked);
  });
  checkboxLabel.appendChild(checkbox);

  const main = document.createElement("div");
  main.className = "todo-main";

  if (editing) {
    main.appendChild(buildInlineEditInput(todo));
  } else {
    const titleEl = document.createElement("div");
    titleEl.className = "todo-title";
    titleEl.textContent = todo.title;
    // 編輯入口：點文字就地編輯。
    titleEl.setAttribute("role", "button");
    titleEl.setAttribute("tabindex", "0");
    titleEl.title = "點擊編輯";
    titleEl.addEventListener("click", () => startInlineEdit(todo));
    titleEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        startInlineEdit(todo);
      }
    });
    main.appendChild(titleEl);
  }

  // 第二行：截止日期。淡灰、字級比標題小，永遠獨立一行，唯讀。
  const dueEl = document.createElement("div");
  dueEl.className = "todo-due";
  dueEl.textContent = formatDate(todo.dueDate);
  main.appendChild(dueEl);

  // 倒數中：再往下顯示「已完成 · 撤銷」。
  if (pending) main.appendChild(buildUndoBar(todo.id));
  if (isPendingDelete(todo.id)) {
    main.appendChild(buildUndoBar(todo.id, "已刪除", undoDelete));
  }

  const archiveBtn = document.createElement("button");
  archiveBtn.type = "button";
  archiveBtn.className = "todo-archive";
  archiveBtn.textContent = "✕";
  // 編輯或其他倒數中不可刪除，避免同一列同時進行衝突操作。
  archiveBtn.disabled = editing || pending || isPendingDelete(todo.id);
  archiveBtn.setAttribute("aria-label", `永久刪除：${todo.title}`);
  archiveBtn.title = "永久刪除";
  archiveBtn.addEventListener("click", () => startDeleteCountdown(todo.id));

  const container = document.createElement("div");
  container.style.display = "contents";
  container.append(checkboxLabel, main, archiveBtn);
  wrapper.appendChild(container);
  return wrapper;
}

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

// 送出按鈕的參照。
const chatSubmitBtn = chatFormEl.querySelector('button[type="submit"]');

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

/** 頭像的顯示尺寸（px），需與 style.css 的 .chat-avatar 一致。 */
const CHAT_AVATAR_SIZE = 38;

/**
 * 建立 Mia 的頭像元素。
 *
 * 兩種尺寸交給瀏覽器用 srcset + sizes 自己挑一張下載——標準行為就是
 * 「只取一個候選」，不會兩張都載入。96 給一般密度、192 給高密度螢幕。
 * 圓形裁切由 CSS 的 border-radius + object-fit 處理。
 */
function buildAvatar() {
  const avatar = document.createElement("img");
  avatar.className = "chat-avatar";
  avatar.width = CHAT_AVATAR_SIZE;
  avatar.height = CHAT_AVATAR_SIZE;
  avatar.srcset =
    "icons/mia-avatar-96.png 96w, icons/mia-avatar-192.png 192w";
  avatar.sizes = `${CHAT_AVATAR_SIZE}px`;
  // 不支援 srcset 的舊瀏覽器才會用到 src；支援的一律走上面的候選清單。
  avatar.src = "icons/mia-avatar-96.png";
  avatar.alt = "";
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}

/** 建立一則訊息的 row（AI 訊息含頭像；使用者訊息維持純文字）。 */
function buildChatRow(msg) {
  const isUser = msg.role === "user";
  const row = document.createElement("div");
  row.className = `chat-row ${isUser ? "user" : "ai"}`;

  if (!isUser) row.appendChild(buildAvatar());

  const bubble = document.createElement("div");
  bubble.className = `chat-message ${isUser ? "user" : "ai"}`;

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

  chatMessages.forEach((msg, index) => {
    const row = buildChatRow(msg);
    // 只讓最新一則做彈入動畫，避免每次送出新訊息時整段歷史都重新彈一次。
    if (index === chatMessages.length - 1) {
      row.classList.add("chat-row-enter");
    }
    chatMessagesEl.appendChild(row);
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

/** 建立一個帶 AI 頭像的暫時 row（目前僅供錯誤泡泡使用）。 */
function buildTransientAiRow(bubbleClass, textContent) {
  const row = document.createElement("div");
  row.className = "chat-row ai chat-row-enter";
  row.appendChild(buildAvatar());
  const bubble = document.createElement("div");
  bubble.className = `chat-message ai ${bubbleClass}`;
  bubble.textContent = textContent;
  row.appendChild(bubble);
  return row;
}

/** 等待回覆時插在對話區底部的三點泡泡的 id。 */
const CHAT_TYPING_BUBBLE_ID = "chat-typing-bubble";

/**
 * 對話區底部的「Mia 正在打字」泡泡：沿用 AI 訊息泡泡的樣式與進場動畫，
 * 內容換成放大版的三顆點。
 *
 * 它不進 chatMessages 陣列、也不寫進 localStorage —— 純粹是暫時的視覺元素，
 * 回覆抵達時直接移除。無障礙狀態已由 #chat-typing 那條指示器播報，
 * 這裡標成 aria-hidden 避免螢幕閱讀器唸兩次。
 */
function buildTypingBubble() {
  const row = document.createElement("div");
  row.className = "chat-row ai chat-row-enter";
  row.id = CHAT_TYPING_BUBBLE_ID;
  row.setAttribute("aria-hidden", "true");
  row.appendChild(buildAvatar());

  const bubble = document.createElement("div");
  bubble.className = "chat-message ai chat-typing-bubble";

  const dots = document.createElement("span");
  dots.className = "chat-typing-dots";
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("span");
    dot.className = "chat-typing-dot";
    dots.appendChild(dot);
  }
  bubble.appendChild(dots);

  row.appendChild(bubble);
  return row;
}

function removeTypingBubble() {
  const el = document.getElementById(CHAT_TYPING_BUBBLE_ID);
  if (el) el.remove();
}

/**
 * 等待 AI 回覆時的兩個提示，刻意同時顯示：
 *   1. 輸入框正上方那條窄的「Mia 輸入中」指示器（#chat-typing）
 *   2. 對話區底部、AI 側的放大版三點泡泡
 */
function showChatThinking() {
  chatTypingEl.hidden = false;
  removeTypingBubble(); // 保險：不要疊出第二顆
  chatMessagesEl.appendChild(buildTypingBubble());
  // 指示器與泡泡都會佔高度，重新捲到底讓泡泡可見、也不蓋住最後一則訊息。
  scrollChatToBottom();
}

function hideChatThinking() {
  chatTypingEl.hidden = true;
  removeTypingBubble();
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
 * 輸入框現在是多行 textarea：Enter 一律換行，不送出訊息，
 * 訊息只能靠按「送出」鈕發出。
 *
 * 這裡仍保留中文輸入法選字（composition）的判斷邏輯，不因為 Enter
 * 不再送出就一併刪除：composing 中的 Enter（isComposing / 舊瀏覽器
 * 用 keyCode === 229 判斷）一律交給輸入法處理、不做任何攔截；非
 * composing 的 Enter 也不攔截，直接讓瀏覽器對 textarea 的原生行為
 * （換行）發生。textarea 原生就不會因為 Enter 觸發表單送出，所以
 * 兩種情況都不需要 preventDefault。
 */
chatInputEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.isComposing || e.keyCode === 229) return; // 輸入法選字中，交給輸入法處理
  // 非選字中的 Enter：不攔截，讓 textarea 正常換行。
});

/**
 * 依內容高度自動增高，超過 CSS max-height（約 5 行）後改由內部捲動。
 *
 * 內容清空時（例如送出後、或使用者手動刪到空白）直接清掉行內高度，
 * 交回 CSS min-height 決定高度，不要用 scrollHeight 去量——因為欄位
 * 空白時瀏覽器顯示的是 placeholder 文字，這裡的 placeholder 較長，
 * 在目前欄寬下會換成兩行，若照樣用 scrollHeight 量測，量到的其實是
 * 「placeholder 換行後」的高度，會讓清空後的欄位錯誤地維持在多行高度。
 */
function resizeChatInput() {
  if (!chatInputEl.value) {
    chatInputEl.style.height = "";
    return;
  }
  chatInputEl.style.height = "auto";
  chatInputEl.style.height = `${chatInputEl.scrollHeight}px`;
}

chatInputEl.addEventListener("input", resizeChatInput);

/* --------------------------------------------------------------------------
 * iOS 鍵盤避讓
 * --------------------------------------------------------------------------
 * iOS Safari 鍵盤彈出時不會縮小版面視窗（layout viewport），只會捲動頁面，
 * 因此 fixed 定位的聊天視窗會被鍵盤蓋住。這裡用 visualViewport 量出鍵盤高度
 * 寫進 --keyboard-inset；CSS 據此把視窗下緣往上抬、同時等量縮短高度，
 * 因為上緣位置不變，效果就是「訊息區被壓縮」而不是整個視窗被推出畫面。
 * ------------------------------------------------------------------------ */
if (window.visualViewport) {
  const updateKeyboardInset = () => {
    const vv = window.visualViewport;
    // 版面高度與可視高度的差，扣掉可視區被捲動的位移，即為鍵盤佔用的高度。
    const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty(
      "--keyboard-inset",
      `${Math.round(inset)}px`
    );
  };
  window.visualViewport.addEventListener("resize", updateKeyboardInset);
  window.visualViewport.addEventListener("scroll", updateKeyboardInset);
  updateKeyboardInset();
}

chatFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isChatBusy) return; // 送出中，忽略重複送出

  const message = chatInputEl.value.trim();
  if (!message) return;

  addChatMessage("user", message);
  chatFormEl.reset();
  resizeChatInput(); // reset() 不會清掉 JS 設定的 inline height，要手動收回單行高度

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
  // 開抽屜時重新確認一次推播狀態：使用者可能在系統設定裡改過通知權限，
  // 那不會觸發任何網頁事件，只能在每次開啟時重新讀。
  if (isDrawerOpen()) refreshPushUi();
});
drawerCloseEl.addEventListener("click", closeDrawer);
drawerBackdropEl.addEventListener("click", closeDrawer);

/* ==========================================================================
 * 每日提醒（Web Push 訂閱）
 * --------------------------------------------------------------------------
 * 訂閱資料存在 Supabase 的 push_subscriptions，每天早上由 GitHub Actions
 * （scripts/daily-reminder.mjs）用 web-push 發送。
 *
 * 這裡要處理的狀態比想像中多，整理成一張表：
 *
 *   狀態                        開關    說明文字
 *   ------------------------    ----    --------------------------------
 *   VAPID 公鑰未設定            停用    尚未設定推播金鑰
 *   瀏覽器不支援                停用    這個瀏覽器不支援
 *   iOS 但不是主畫面模式        停用    另外顯示「加入主畫面」提示
 *   通知權限已被拒絕            停用    另外顯示「到系統設定開啟」提示
 *   已訂閱                      開啟    已開啟
 *   未訂閱                      關閉    已關閉
 *
 * ⚠️ 權限請求一律由使用者點開關觸發，絕不在載入時自動跳。
 *    瀏覽器對「未經互動就請求權限」的網站會直接封鎖，而且一旦被拒絕，
 *    程式就再也要不回來了（只能請使用者自己去系統設定改）。
 * ========================================================================== */

/** VAPID 公鑰由使用者填在 config.js（見該檔案的說明）。留空代表尚未設定。 */
const VAPID_PUBLIC_KEY = (window.APP_CONFIG.VAPID_PUBLIC_KEY || "").trim();

/**
 * VAPID 公鑰是 base64url 字串，但 pushManager.subscribe() 的
 * applicationServerKey 只吃 Uint8Array，要自己轉。
 * base64url 與標準 base64 的差別：-_ 對應 +/，而且尾端沒有 = 補齊。
 */
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

function isPushSupported() {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** 是否從主畫面圖示開啟（PWA standalone）。iOS 用的是非標準的 navigator.standalone。 */
function isStandaloneMode() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

/**
 * 是否為 iOS／iPadOS。
 * iPadOS 13 之後的 Safari 預設回報成 Macintosh，所以額外用
 * 「有觸控點的 Mac」這個特徵補判斷，否則 iPad 會被誤判成桌機、
 * 拿不到「要先加入主畫面」的提示。
 */
function isIosDevice() {
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}

/** 取得目前這台裝置的推播訂閱（沒有就回 null）。 */
async function getCurrentSubscription() {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

/**
 * 依目前環境與訂閱狀態重畫抽屜裡的開關。
 * 這是唯一決定開關外觀的地方——所有流程結束後都回來呼叫它，
 * 而不是各自去改 checkbox，避免畫面與實際狀態不一致。
 */
async function refreshPushUi() {
  if (!pushToggleEl) return;

  const setState = ({ checked, disabled, status, iosHint = false }) => {
    pushToggleEl.checked = checked;
    pushToggleEl.disabled = disabled;
    pushStatusEl.textContent = status;
    pushIosHintEl.hidden = !iosHint;
  };

  if (!VAPID_PUBLIC_KEY) {
    setState({
      checked: false,
      disabled: true,
      status: "尚未設定推播金鑰（config.js 的 VAPID_PUBLIC_KEY 還是空的）。",
    });
    return;
  }

  if (!isPushSupported()) {
    setState({
      checked: false,
      disabled: true,
      status: "這個瀏覽器不支援推播通知。",
    });
    return;
  }

  // iOS 只有在「加入主畫面」後才支援 Web Push，用瀏覽器直接開是訂不了的。
  if (isIosDevice() && !isStandaloneMode()) {
    setState({
      checked: false,
      disabled: true,
      status: "",
      iosHint: true,
    });
    return;
  }

  // 被拒絕過就不再請求（也請求不到），只能引導去系統設定改。
  if (Notification.permission === "denied") {
    setState({
      checked: false,
      disabled: true,
      status:
        "通知權限已被拒絕。要重新開啟，請到瀏覽器或系統的網站設定中，把這個網站的通知權限改成「允許」，再回來開啟這個開關。",
    });
    return;
  }

  const subscription = await getCurrentSubscription();
  setState({
    checked: Boolean(subscription),
    disabled: false,
    status: subscription
      ? "已開啟。每天早上會把當天的待辦推播到這台裝置。"
      : "已關閉。開啟後會請求通知權限。",
  });
}

/** 開啟：請求權限 → 建立訂閱 → 寫進 Supabase。 */
async function enablePush() {
  // 這一步必須在使用者手勢中呼叫，所以只能從開關的事件處理裡進來。
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    // 使用者按了「封鎖」或直接關掉對話框：不重試、不再問，交給 refreshPushUi
    // 顯示對應說明（denied 會走到「請到系統設定開啟」那一支）。
    await refreshPushUi();
    return;
  }

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    // userVisibleOnly: true 是必填，代表「收到推播一定會顯示通知」。
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });

  const json = subscription.toJSON();
  const { error } = await supabaseClient.from("push_subscriptions").upsert(
    {
      user_id: currentUser.id,
      endpoint: subscription.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      // 之前關過又重開時要把封存時間清掉，否則排程會當它還是取消狀態。
      revoked_at: null,
    },
    // 同一台裝置重新訂閱時 endpoint 不變，靠它更新既有那一列，
    // 不要每次開關都新增一筆（會收到重複通知）。
    { onConflict: "endpoint" }
  );

  if (error) {
    // 資料庫沒寫成功的話，本地訂閱留著也沒意義（排程讀不到），直接退掉，
    // 讓畫面回到「已關閉」，而不是顯示已開啟卻永遠收不到通知。
    await subscription.unsubscribe();
    throw new Error(`訂閱寫入失敗：${error.message}`);
  }
}

/** 關閉：退掉本地訂閱 → 在 Supabase 寫入 revoked_at（UPDATE，不是 DELETE）。 */
async function disablePush() {
  const subscription = await getCurrentSubscription();
  if (!subscription) return;

  const { endpoint } = subscription;
  await subscription.unsubscribe();

  const { error } = await supabaseClient
    .from("push_subscriptions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("endpoint", endpoint);

  if (error) throw new Error(`取消訂閱寫入失敗：${error.message}`);
}

if (pushToggleEl) {
  pushToggleEl.addEventListener("change", async () => {
    // 使用者按下的當下 checkbox 已經自己翻面了，但真正的狀態要等
    // 權限與資料庫都完成才算數。先鎖住避免連點，全部做完再由
    // refreshPushUi() 依「實際狀態」重畫，畫面就不會跟事實脫節。
    const wantOn = pushToggleEl.checked;
    pushToggleEl.disabled = true;
    pushStatusEl.textContent = wantOn ? "正在開啟…" : "正在關閉…";

    try {
      if (wantOn) await enablePush();
      else await disablePush();
    } catch (err) {
      console.error("推播設定失敗：", err);
      await refreshPushUi();
      pushStatusEl.textContent = `設定失敗：${err.message}`;
      return;
    }

    await refreshPushUi();
  });
}

/* ==========================================================================
 * 全部待辦：全螢幕檢視（與月曆互斥）
 * --------------------------------------------------------------------------
 * 沿用專案既有的 .is-open class 慣例，不引入分頁結構、路由或 hash。
 * 開啟時月曆隱藏、關閉時月曆復原，兩者互斥。
 * ========================================================================== */

function isTodosOpen() {
  return todosViewEl.classList.contains("is-open");
}

function openTodosView() {
  todosViewEl.classList.add("is-open");
  calendarViewEl.hidden = true; // 與月曆互斥
  setActiveNav("todos");
  closeDrawer(); // 切換畫面時順手收起抽屜，避免蓋住新畫面
}

function closeTodosView() {
  todosViewEl.classList.remove("is-open");
  calendarViewEl.hidden = false;
  setActiveNav("calendar");
}

/* --------------------------------------------------------------------------
 * 從通知進入待辦一覽
 * --------------------------------------------------------------------------
 * 點擊推播通知有兩種情況，兩邊都要接：
 *
 *   a) App 沒開著 → Service Worker 用 openWindow('./index.html#todos')
 *      開新視窗，這裡在載入時讀 hash。
 *   b) App 已經開著 → Service Worker 聚焦那個分頁並 postMessage，
 *      因為對一個已載入的分頁改 hash 不會觸發任何事情。
 *
 * 這個 hash 只是通知的進入點標記，讀完就用 replaceState 清掉，
 * 不參與畫面狀態、也不做路由——重新整理不會再跳到待辦一覽。
 * ------------------------------------------------------------------------ */

/** 若網址帶著 #todos（從通知冷啟動），切到待辦一覽並清掉 hash。 */
function consumeNotificationHash() {
  if (window.location.hash !== "#todos") return;
  openTodosView();
  history.replaceState(
    null,
    "",
    window.location.pathname + window.location.search
  );
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data.type === "navigate" && data.view === "todos") {
      openTodosView();
    }
  });
}

/* ==========================================================================
 * 底部導航列
 * --------------------------------------------------------------------------
 * 前三格切換畫面（有選取狀態），後兩格是動作（無選取狀態）。
 * 備忘錄與夜間模式此階段只是佔位，點擊顯示「開發中」提示。
 * ========================================================================== */

/** 設定前三格的選取狀態（後兩格是動作，不參與）。 */
function setActiveNav(navId) {
  bottomNavEl.querySelectorAll("[data-nav]").forEach((btn) => {
    const isActive = btn.dataset.nav === navId;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-current", isActive ? "page" : "false");
  });
}

let toastTimer = null;

/** 簡易提示條（給尚未實作的佔位功能用）。 */
function showToast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  // 先移除再強制 reflow，讓連續點擊時動畫能重新播放。
  toastEl.classList.remove("is-visible");
  void toastEl.offsetWidth;
  toastEl.classList.add("is-visible");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("is-visible");
    setTimeout(() => {
      toastEl.hidden = true;
    }, 200);
  }, 1600);
}

navCalendarEl.addEventListener("click", () => {
  closeTodosView();
  closeDrawer();
});

navTodosEl.addEventListener("click", () => {
  openTodosView();
});

navNotesEl.addEventListener("click", () => {
  showToast("備忘錄開發中");
});

navDarkEl.addEventListener("click", () => {
  showToast("夜間模式開發中");
});

// 登出：沿用原本 logoutBtn 的行為（原本在標頭的按鈕已移除）。
navLogoutEl.addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  // 由 onAuthStateChange 接手切換畫面。
});

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
  // 刻意不自動 focus 輸入框：手機上會立刻喚起鍵盤、畫面上推，
  // 蓋住剛展開的彈出動畫與聊天記錄。改由使用者自己點擊輸入框喚起鍵盤。
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

// ESC 收起浮層（聊天視窗、列表抽屜、年月選擇、新增待辦 modal）。
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (isChatPanelOpen()) closeChatPanel();
  if (isDrawerOpen()) closeDrawer();
  if (isCalJumpOpen()) closeCalJump();
  if (isAddTodoOpen()) closeAddTodo();
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
    renderChatMessages();
    fetchTodos();
    // 抽屜裡的每日提醒開關要等登入後才有意義（訂閱要綁 user_id）。
    refreshPushUi();
    // 從通知冷啟動時直接進待辦一覽。放在登入後才做，
    // 未登入時整個 #app-main 是隱藏的，切了也看不到。
    consumeNotificationHash();
  } else {
    // 登出後清掉畫面上的資料，避免殘留，並收起所有浮層／回到月曆。
    todos = [];
    clearInlineEdit(); // 編輯到一半登出，狀態不要留到下次登入
    todoListEl.innerHTML = "";
    todoEmptyEl.hidden = true;
    calGridEl.innerHTML = "";
    dayListEl.innerHTML = "";
    closeChatPanel();
    closeDrawer();
    closeTodosView(); // 關閉全部待辦畫面，下次登入回到月曆
    closeCalJump();
    closeAddTodo();
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

// 登出的按鈕已移到底部導航列（見上方 navLogoutEl 的處理）。

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
  // 年月選擇浮層的內容改為開啟時才產生（見 openCalJump），不需預先初始化。
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
