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

function renderTodos() {
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
 * AI 行程規劃對話區 (Chat) —— 維持 mock，暫存於 localStorage
 * ========================================================================== */

const CHAT_STORAGE_KEY = "schedule-todo:chatMessages";

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

function addChatMessage(role, content) {
  const message = {
    id: generateId(),
    role,
    content,
    createdAt: new Date().toISOString(),
  };
  chatMessages.push(message);
  persistChatMessages();
  renderChatMessages();
  return message;
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
    const bubble = document.createElement("div");
    bubble.className = `chat-message ${msg.role === "user" ? "user" : "ai"}`;

    const text = document.createElement("span");
    text.textContent = msg.content;

    const time = document.createElement("time");
    time.className = "chat-time";
    time.textContent = formatDateTime(msg.createdAt);

    bubble.append(text, time);
    chatMessagesEl.appendChild(bubble);
  });

  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

/**
 * -----------------------------------------------------------------------
 * 【未來 Claude API 介接點】
 * -----------------------------------------------------------------------
 * 目前回傳 mock 的 AI 回覆字串。未來串接 Claude API 時：
 *   1. 呼叫 getTodosContext() 取得目前所有待辦事項作為上下文。
 *   2. 將使用者訊息 + 待辦事項上下文送給後端 Claude API 代理服務
 *      （前端不可直接夾帶 API Key 呼叫）。
 *   3. 等待回覆後呼叫 addChatMessage('ai', 回覆內容)。
 */
async function getAIResponse(userMessage) {
  const todosContext = getTodosContext();
  void userMessage;
  void todosContext;

  // TODO(未來): 改為呼叫後端 Claude API 代理服務並回傳真正的 AI 回覆。
  return "未來 Claude API 將會根據目前待辦事項提供建議。";
}

/** 整理目前所有待辦事項成為 AI 對話上下文（預留給未來串接 Claude API）。 */
function getTodosContext() {
  return sortTodos(todos).map((t) => ({
    title: t.title,
    dueDate: t.dueDate,
    isOverdue: !t.completedAt && isOverdue(t.dueDate),
    isCompleted: Boolean(t.completedAt),
  }));
}

chatFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = chatInputEl.value.trim();
  if (!message) return;

  addChatMessage("user", message);
  chatFormEl.reset();
  chatInputEl.focus();

  const reply = await getAIResponse(message);
  addChatMessage("ai", reply);
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
    // 登出後清掉畫面上的資料，避免殘留。
    todos = [];
    todoListEl.innerHTML = "";
    todoEmptyEl.hidden = true;
  }
}

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
 * 初始化 (Init)
 * ========================================================================== */

async function init() {
  // 監聽登入狀態變化（登入、登出、token 更新都會觸發）。
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    renderAuthState(session ? session.user : null);
  });

  // 檢查是否已有登入 session（重新整理後保持登入）。
  const { data } = await supabaseClient.auth.getSession();
  renderAuthState(data.session ? data.session.user : null);
}

init();
