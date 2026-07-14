"use strict";

/* ==========================================================================
 * 資料儲存 (Storage)
 * --------------------------------------------------------------------------
 * 本版本使用瀏覽器 localStorage 儲存所有資料（待辦事項 + 聊天紀錄）。
 *
 * 限制：
 *   - 資料只存在「單一裝置、單一瀏覽器」中。
 *   - 換一台電腦、換一個瀏覽器，或使用者清除瀏覽器資料 / 隱私瀏覽模式，
 *     資料就會遺失，無法跨裝置同步。
 *   - localStorage 容量有限（通常各瀏覽器約 5–10MB），不適合存放大量歷史資料。
 *
 * 未來若要支援跨裝置保存，建議方向：
 *   - 導入後端服務 + 資料庫（例如 Firebase / Supabase / 自建 Node.js + PostgreSQL），
 *     搭配使用者帳號登入（OAuth 或 Email/密碼）。
 *   - 前端改用該服務提供的 SDK 或 REST/GraphQL API 讀寫資料，
 *     localStorage 僅作為離線快取 (offline cache) 使用。
 *   - 需要處理多裝置同步時的資料衝突 (conflict resolution)，
 *     可用 updatedAt 時間戳記做 last-write-wins，或導入更完整的同步機制。
 * ========================================================================== */

const STORAGE_KEYS = {
  todos: "schedule-todo:todos",
  chatMessages: "schedule-todo:chatMessages",
};

function loadFromStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.warn(`讀取 localStorage (${key}) 失敗，使用預設值。`, err);
    return fallback;
  }
}

function saveToStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn(`寫入 localStorage (${key}) 失敗。`, err);
  }
}

/* ==========================================================================
 * 狀態 (State)
 * ========================================================================== */

/** @type {Array<{id:string, title:string, dueDate:string, createdAt:string, updatedAt:string}>} */
let todos = loadFromStorage(STORAGE_KEYS.todos, []);

/** @type {Array<{id:string, role:'user'|'ai', content:string, createdAt:string}>} */
let chatMessages = loadFromStorage(STORAGE_KEYS.chatMessages, []);

function persistTodos() {
  saveToStorage(STORAGE_KEYS.todos, todos);
}

function persistChatMessages() {
  saveToStorage(STORAGE_KEYS.chatMessages, chatMessages);
}

function generateId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ==========================================================================
 * 待辦事項邏輯 (Todos)
 * ========================================================================== */

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

/**
 * 排序規則：
 *   1. 未到期事項優先（尚未過期的排在已過期的前面）
 *   2. 依截止日期由近到遠排序
 *   3. 相同日期依建立時間排序（先建立的在前）
 */
function sortTodos(list) {
  return [...list].sort((a, b) => {
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

function addTodo(title, dueDate) {
  const now = new Date().toISOString();
  const todo = {
    id: generateId(),
    title: title.trim(),
    dueDate,
    createdAt: now,
    updatedAt: now,
  };
  todos.push(todo);
  persistTodos();
  renderTodos();
}

function updateTodo(id, changes) {
  const todo = todos.find((t) => t.id === id);
  if (!todo) return;
  Object.assign(todo, changes, { updatedAt: new Date().toISOString() });
  persistTodos();
  renderTodos();
}

function deleteTodo(id) {
  todos = todos.filter((t) => t.id !== id);
  persistTodos();
  renderTodos();
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

/* ---- Rendering ---- */

const todoListEl = document.getElementById("todo-list");
const todoEmptyEl = document.getElementById("todo-empty");
const todoFormEl = document.getElementById("todo-form");
const todoTitleInput = document.getElementById("todo-title");
const todoDueDateInput = document.getElementById("todo-due-date");

let editingId = null;

function renderTodos() {
  const sorted = sortTodos(todos);
  todoListEl.innerHTML = "";
  todoEmptyEl.hidden = sorted.length > 0;

  sorted.forEach((todo) => {
    const li = document.createElement("li");
    li.className = "todo-item" + (isOverdue(todo.dueDate) ? " is-overdue" : "");
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
    isOverdue(todo.dueDate) ? "（已過期）" : ""
  }`;

  const created = document.createElement("span");
  created.textContent = `建立：${formatDateTime(todo.createdAt)}`;

  meta.append(due, created);
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
  container.append(main, actions);
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
  todoTitleInput.focus();
});

/* ==========================================================================
 * AI 行程規劃對話區 (Chat)
 * ========================================================================== */

const chatMessagesEl = document.getElementById("chat-messages");
const chatFormEl = document.getElementById("chat-form");
const chatInputEl = document.getElementById("chat-input");

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
 * 這個函式目前回傳 mock 的 AI 回覆字串。
 *
 * 未來串接 Claude API 時，應該把這裡改成：
 *   1. 呼叫 getTodosContext() 取得目前所有待辦事項，組成上下文 (context)。
 *   2. 將使用者輸入的訊息 + 待辦事項上下文，一起送給後端代理服務
 *      （見檔案最下方 Claude API 串接規劃說明，前端不可直接夾帶 API Key 呼叫）。
 *   3. 等待後端回傳 Claude 的回覆內容，再呼叫 addChatMessage('ai', 回覆內容)。
 *
 * @param {string} userMessage 使用者輸入的訊息
 * @returns {Promise<string>} AI 回覆內容
 */
async function getAIResponse(userMessage) {
  // 目前所有待辦事項，未來會作為 Claude API 的上下文一併傳送。
  const todosContext = getTodosContext();
  void userMessage;
  void todosContext;

  // TODO(未來): 將 userMessage 與 todosContext 一起送給後端 Claude API 代理服務，
  // 並回傳真正的 AI 回覆，取代下方的 mock 回應。
  return "未來 Claude API 將會根據目前待辦事項提供建議。";
}

/**
 * 整理目前所有待辦事項成為適合當作 AI 對話上下文的格式。
 * 這是預留給未來串接 Claude API 使用的介接點。
 */
function getTodosContext() {
  return sortTodos(todos).map((t) => ({
    title: t.title,
    dueDate: t.dueDate,
    isOverdue: isOverdue(t.dueDate),
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
 * 初始化 (Init)
 * ========================================================================== */

function init() {
  // 新增待辦事項的日期欄位預設為今天，方便使用者操作。
  todoDueDateInput.value = new Date().toISOString().slice(0, 10);
  renderTodos();
  renderChatMessages();
}

init();
