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

/** 整理目前所有待辦事項成為 AI 對話上下文，送給 Edge Function。 */
function getTodosContext() {
  return sortTodos(todos).map((t) => ({
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

/** 顯示 / 移除「思考中...」暫時泡泡（不納入 chatMessages，不會被存到 localStorage）。 */
function showChatThinking() {
  const bubble = document.createElement("div");
  bubble.className = "chat-message ai chat-pending";
  bubble.textContent = "思考中...";
  chatMessagesEl.appendChild(bubble);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  chatPendingBubble = bubble;
}

function hideChatThinking() {
  if (chatPendingBubble && chatPendingBubble.parentNode) {
    chatPendingBubble.parentNode.removeChild(chatPendingBubble);
  }
  chatPendingBubble = null;
}

/** 顯示一則暫時的錯誤泡泡（不存進歷史，下次送出時會被重繪清掉）。 */
function showChatError(text) {
  const bubble = document.createElement("div");
  bubble.className = "chat-message ai chat-error";
  bubble.textContent = `⚠️ ${text}`;
  chatMessagesEl.appendChild(bubble);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
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
  return data.reply;
}

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
    const reply = await callChatFunction(
      toApiMessages(recent),
      getTodosContext(),
      accessToken
    );

    hideChatThinking();
    addChatMessage("ai", reply);
  } catch (err) {
    hideChatThinking();
    showChatError(err.message || "發生未知錯誤，請稍後再試。");
  } finally {
    setChatBusy(false);
    chatInputEl.focus();
  }
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
