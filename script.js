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
const tabBarEl = document.getElementById("tab-bar");

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
 * 分頁 (Tabs)
 * --------------------------------------------------------------------------
 * 資料驅動：要新增分頁（例如「讀書計劃」「股票」），只要在 TABS 陣列加一筆，
 * 並在 index.html 對應加一個 <section class="tab-panel" id="panel-xxx">。
 * 切換分頁只切換顯示，不會重新抓資料。
 *   - id：分頁識別
 *   - label：按鈕文字（含 emoji）
 *   - panelId：對應的內容區塊 element id
 *   - onActivate：切到此分頁時要跑的（可選）副作用，例如捲到底
 * ========================================================================== */

const TABS = [
  {
    id: "chat",
    label: "💬 AI 助理",
    panelId: "panel-chat",
    onActivate: () => scrollChatToBottom(),
  },
  { id: "todo", label: "📋 待辦事項", panelId: "panel-todo" },
];

let activeTabId = TABS[0].id;

function renderTabBar() {
  tabBarEl.innerHTML = "";
  TABS.forEach((tab) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = `tab-btn-${tab.id}`;
    btn.className = "tab-btn" + (tab.id === activeTabId ? " is-active" : "");
    btn.textContent = tab.label;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", tab.id === activeTabId ? "true" : "false");
    btn.setAttribute("aria-controls", tab.panelId);
    btn.addEventListener("click", () => setActiveTab(tab.id));
    tabBarEl.appendChild(btn);
  });
}

function setActiveTab(tabId) {
  const target = TABS.find((t) => t.id === tabId);
  if (!target) return;
  activeTabId = tabId;

  TABS.forEach((tab) => {
    const isActive = tab.id === tabId;
    const panel = document.getElementById(tab.panelId);
    if (panel) panel.classList.toggle("is-active", isActive);
    const btn = document.getElementById(`tab-btn-${tab.id}`);
    if (btn) {
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    }
  });

  // 切換只影響顯示，不重新抓資料；只跑該分頁需要的輕量副作用。
  if (typeof target.onActivate === "function") target.onActivate();
}

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
  // 建立分頁列並套用預設分頁（TABS[0]，即 AI 助理）。
  renderTabBar();
  setActiveTab(activeTabId);

  // 每分鐘更新一次聊天訊息的相對時間顯示。
  setInterval(refreshChatTimes, 60000);

  // 監聽登入狀態變化（登入、登出、token 更新都會觸發）。
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    renderAuthState(session ? session.user : null);
  });

  // 檢查是否已有登入 session（重新整理後保持登入）。
  const { data } = await supabaseClient.auth.getSession();
  renderAuthState(data.session ? data.session.user : null);
}

init();
