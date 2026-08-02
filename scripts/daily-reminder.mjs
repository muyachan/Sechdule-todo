// @ts-check
/**
 * 每日待辦事項提醒。
 *
 * 由 GitHub Actions 排程執行（每天台灣時間早上 06:00），流程：
 *   1. 以 Asia/Taipei 時區算出「今天」的日期。
 *   2. 用 Supabase REST API 讀取 todos，篩選「未完成且截止日在今天(含)以前」。
 *   3. 沒有任何待辦就直接結束，兩個管道都不發。
 *   4. 發送到兩個管道（互不影響，其中一邊失敗不會拖垮另一邊）：
 *        a) Discord Webhook —— 既有行為，維持不變。
 *        b) Web Push       —— 推播到所有 revoked_at is null 的 PWA 訂閱。
 *
 * 需要的環境變數：
 *   - SUPABASE_URL                 Supabase 專案 URL
 *   - SUPABASE_SERVICE_ROLE_KEY    service_role 金鑰（可繞過 RLS 讀取全部資料，
 *                                  這是預期行為，此資料庫僅單一使用者）
 *   - DISCORD_WEBHOOK_URL          Discord 頻道的 Incoming Webhook URL
 *   - VAPID_PRIVATE_KEY            Web Push 的 VAPID 私鑰
 *   - VAPID_PUBLIC_KEY             Web Push 的 VAPID 公鑰（與 config.js 內同一把）
 *   - VAPID_SUBJECT                VAPID 的聯絡方式（mailto: 或 https: 開頭）
 */

import webpush from "web-push";
import { applyDueTodoFilters } from "./todo-query-filters.js";

/**
 * 以指定時區取得「今天」的 YYYY-MM-DD 字串。
 * 用 en-CA locale 會直接輸出 ISO 格式的 YYYY-MM-DD。
 * @param {string} timeZone
 * @param {Date} [now]
 * @returns {string}
 */
export function getTodayInTimeZone(timeZone, now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(now); // e.g. "2026-07-20"
}

/**
 * 將 YYYY-MM-DD 轉為顯示用的 M/D（無前導 0）。
 * @param {string} isoDate
 * @returns {string}
 */
export function toShortDate(isoDate) {
  const [, m, d] = isoDate.split("-");
  return `${Number(m)}/${Number(d)}`;
}

/**
 * 根據待辦清單與今天日期，組出要發到 Discord 的訊息字串。
 *
 * @param {Array<{title:string, due_date:string, completed_at:string|null}>} todos
 *        已篩選過（未完成、截止日 <= 今天）的待辦清單。
 * @param {string} todayStr 今天日期（Asia/Taipei，YYYY-MM-DD）。
 * @returns {string}
 */
export function buildMessage(todos, todayStr) {
  if (!todos || todos.length === 0) {
    return "今天沒有待辦事項，好好休息！";
  }

  // 已過期：截止日早於今天；今天截止：截止日等於今天。
  const overdue = todos
    .filter((t) => t.due_date < todayStr)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  const dueToday = todos.filter((t) => t.due_date === todayStr);

  const lines = [`☀️ 早安！今天（${toShortDate(todayStr)}）的待辦事項：`];

  for (const t of overdue) {
    lines.push(`⚠️ 已過期：${t.title}（原截止 ${toShortDate(t.due_date)}）`);
  }
  for (const t of dueToday) {
    lines.push(`📌 今天截止：${t.title}`);
  }

  lines.push(`共 ${todos.length} 件事，加油！`);
  return lines.join("\n");
}

/**
 * 推播通知的固定格式退回方案。
 *
 * Mia 生成失敗（Edge Function 掛掉、超時、回傳空字串⋯⋯）時一定會用到這個，
 * 所以它不能依賴任何外部服務，純粹由待辦清單組出來。
 *
 * 內文控制在兩行內：最多列兩筆，超過的用「⋯⋯還有 N 件」帶過，
 * iOS 鎖定畫面才不會把重點截掉。
 *
 * @param {Array<{title:string, due_date:string}>} todos
 * @returns {{title:string, body:string}}
 */
export function buildFallbackNotification(todos) {
  const title = `今天 ${todos.length} 件待辦`;

  const shown = todos.slice(0, 2).map((t) => t.title);
  const rest = todos.length - shown.length;
  const body = rest > 0 ? `${shown.join("、")}⋯⋯還有 ${rest} 件` : shown.join("、");

  return { title, body };
}

/**
 * 用 Supabase REST API 讀取「未封存、未完成且截止日 <= 今天」的待辦事項。
 * @param {string} supabaseUrl
 * @param {string} serviceRoleKey
 * @param {string} todayStr YYYY-MM-DD
 * @returns {Promise<Array<{title:string, due_date:string, completed_at:string|null}>>}
 */
export async function fetchDueTodos(supabaseUrl, serviceRoleKey, todayStr) {
  const url = new URL(`${supabaseUrl}/rest/v1/todos`);
  url.searchParams.set("select", "title,due_date,completed_at");
  applyDueTodoFilters(url.searchParams, todayStr);
  url.searchParams.set("order", "due_date.asc");

  const res = await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase 讀取失敗 (${res.status}): ${body}`);
  }
  return res.json();
}

/**
 * 讀取所有「目前有效」的推播訂閱（revoked_at is null）。
 * @param {string} supabaseUrl
 * @param {string} serviceRoleKey
 * @returns {Promise<Array<{id:string, endpoint:string, p256dh:string, auth:string}>>}
 */
export async function fetchActiveSubscriptions(supabaseUrl, serviceRoleKey) {
  const url = new URL(`${supabaseUrl}/rest/v1/push_subscriptions`);
  url.searchParams.set("select", "id,endpoint,p256dh,auth");
  url.searchParams.set("revoked_at", "is.null");

  const res = await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`讀取推播訂閱失敗 (${res.status}): ${body}`);
  }
  return res.json();
}

/**
 * 刪除一筆已失效的訂閱。
 *
 * 推播服務回 410 Gone / 404 Not Found 代表這個 endpoint 已經不存在了
 * （使用者移除 PWA、清掉瀏覽器資料、或推播服務自己過期）。這種列留著只會
 * 每天重試失敗，直接刪掉。
 *
 * 用 service_role 執行，會繞過 RLS —— push_subscriptions 上刻意沒有
 * DELETE policy，前端無法刪除，這裡也不需要 policy。
 *
 * @param {string} supabaseUrl
 * @param {string} serviceRoleKey
 * @param {string} id
 */
export async function deleteSubscription(supabaseUrl, serviceRoleKey, id) {
  const url = new URL(`${supabaseUrl}/rest/v1/push_subscriptions`);
  url.searchParams.set("id", `eq.${id}`);

  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`刪除失效訂閱失敗 (${res.status}): ${body}`);
  }
}

/**
 * 請 Mia（Edge Function）生成推播文案。失敗時回 null，由呼叫端決定退回方案。
 *
 * Authorization 帶 service_role 金鑰：它本身是一個合法的 JWT，
 * 過得了 Edge Function 的 verify_jwt，而且 Edge Function 那邊會比對
 * 這把金鑰以確認呼叫端是排程而不是一般使用者。
 *
 * @param {string} supabaseUrl
 * @param {string} serviceRoleKey
 * @param {Array<{title:string, due_date:string}>} todos
 * @returns {Promise<string|null>} 生成的一句話，失敗回 null
 */
export async function generateMiaCopy(supabaseUrl, serviceRoleKey, todos) {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/bright-worker`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({ mode: "daily-notification", todos }),
      // 排程不該為了一句文案卡住，超過 20 秒就放棄改用退回方案。
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(`⚠️ Mia 文案生成失敗 (${res.status}): ${body}`);
      return null;
    }

    const data = await res.json();
    const text = typeof data.text === "string" ? data.text.trim() : "";
    return text || null;
  } catch (err) {
    console.warn(`⚠️ Mia 文案生成失敗：${err.message}`);
    return null;
  }
}

/**
 * 發送 Web Push 給所有有效訂閱。
 *
 * 每一筆獨立處理：某台裝置失敗不影響其他台。回應 410/404 的訂閱直接刪除。
 *
 * @param {object} params
 * @param {string} params.supabaseUrl
 * @param {string} params.serviceRoleKey
 * @param {Array<{id:string, endpoint:string, p256dh:string, auth:string}>} params.subscriptions
 * @param {{title:string, body:string}} params.notification
 * @returns {Promise<{sent:number, removed:number, failed:number}>}
 */
export async function sendWebPush({
  supabaseUrl,
  serviceRoleKey,
  subscriptions,
  notification,
}) {
  let sent = 0;
  let removed = 0;
  let failed = 0;

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    url: "./index.html#todos",
  });

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        payload
      );
      sent++;
    } catch (err) {
      // web-push 用 statusCode 帶回推播服務的 HTTP 狀態。
      const status = err && err.statusCode;
      if (status === 410 || status === 404) {
        await deleteSubscription(supabaseUrl, serviceRoleKey, sub.id);
        removed++;
        console.log(`🗑️  訂閱已失效 (${status})，已刪除：${sub.endpoint.slice(0, 60)}…`);
      } else {
        failed++;
        console.warn(`⚠️ 推播失敗 (${status || "?"})：${err.message}`);
      }
    }
  }

  return { sent, removed, failed };
}

/**
 * 發送訊息到 Discord Webhook。
 * @param {string} webhookUrl
 * @param {string} content
 */
export async function sendToDiscord(webhookUrl, content) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord 發送失敗 (${res.status}): ${body}`);
  }
}

async function main() {
  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    DISCORD_WEBHOOK_URL,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY,
    VAPID_SUBJECT,
  } = process.env;

  const missing = [
    ["SUPABASE_URL", SUPABASE_URL],
    ["SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY],
    ["DISCORD_WEBHOOK_URL", DISCORD_WEBHOOK_URL],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(`缺少必要的環境變數：${missing.join(", ")}`);
  }

  const todayStr = getTodayInTimeZone("Asia/Taipei");
  const todos = await fetchDueTodos(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    todayStr
  );

  console.log(`今天（Asia/Taipei）：${todayStr}`);
  console.log(`符合條件的待辦：${todos.length} 件`);

  // 沒有任何待辦就不發送——兩個管道都不發。
  if (todos.length === 0) {
    console.log("今天沒有待辦事項，不發送任何提醒。");
    return;
  }

  /* ---------------- Discord（既有行為，維持不變）---------------- */
  const message = buildMessage(todos, todayStr);
  console.log("即將發送到 Discord 的訊息：\n" + message);
  await sendToDiscord(DISCORD_WEBHOOK_URL, message);
  console.log("✅ 已發送到 Discord。");

  /* ---------------- Web Push ---------------- */
  // VAPID 三個變數沒設齊就跳過推播，但不讓整個排程失敗——
  // Discord 那邊已經發出去了，不該因為推播還沒設定好就標記成紅燈。
  const vapidReady = VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT;
  if (!vapidReady) {
    console.log("ℹ️ VAPID 環境變數未設齊，略過 Web Push。");
    return;
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const subscriptions = await fetchActiveSubscriptions(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
  );
  console.log(`有效的推播訂閱：${subscriptions.length} 筆`);

  if (subscriptions.length === 0) {
    console.log("ℹ️ 沒有任何有效訂閱，略過 Web Push。");
    return;
  }

  // 文案優先用 Mia 生成，失敗就用固定格式的退回方案。
  const fallback = buildFallbackNotification(todos);
  const miaText = await generateMiaCopy(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    todos
  );

  const notification = miaText
    ? { title: fallback.title, body: miaText }
    : fallback;

  console.log(
    `推播文案（${miaText ? "Mia 生成" : "退回方案"}）：` +
      `\n  標題：${notification.title}\n  內文：${notification.body}`
  );

  const result = await sendWebPush({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
    subscriptions,
    notification,
  });

  console.log(
    `✅ Web Push 完成：成功 ${result.sent}、` +
      `刪除失效 ${result.removed}、失敗 ${result.failed}。`
  );
}

// 只有「直接執行這個檔案」時才跑 main()，被 import 測試時不會執行。
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("❌ 執行失敗：", err.message);
    process.exit(1);
  });
}
