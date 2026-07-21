// @ts-check
/**
 * 每日待辦事項推播到 Discord。
 *
 * 由 GitHub Actions 排程執行（每天台灣時間早上 7:00），流程：
 *   1. 以 Asia/Taipei 時區算出「今天」的日期。
 *   2. 用 Supabase REST API 讀取 todos，篩選「未完成且截止日在今天(含)以前」。
 *   3. 組成訊息（分成已過期 / 今天截止兩類）後發送到 Discord Webhook。
 *
 * 需要的環境變數：
 *   - SUPABASE_URL                 Supabase 專案 URL
 *   - SUPABASE_SERVICE_ROLE_KEY    service_role 金鑰（可繞過 RLS 讀取全部資料，
 *                                  這是預期行為，此資料庫僅單一使用者）
 *   - DISCORD_WEBHOOK_URL          Discord 頻道的 Incoming Webhook URL
 */

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
 * 用 Supabase REST API 讀取「未完成且截止日 <= 今天」的待辦事項。
 * @param {string} supabaseUrl
 * @param {string} serviceRoleKey
 * @param {string} todayStr YYYY-MM-DD
 * @returns {Promise<Array<{title:string, due_date:string, completed_at:string|null}>>}
 */
export async function fetchDueTodos(supabaseUrl, serviceRoleKey, todayStr) {
  const url = new URL(`${supabaseUrl}/rest/v1/todos`);
  url.searchParams.set("select", "title,due_date,completed_at");
  url.searchParams.set("completed_at", "is.null");
  url.searchParams.set("due_date", `lte.${todayStr}`);
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
  const message = buildMessage(todos, todayStr);

  console.log(`今天（Asia/Taipei）：${todayStr}`);
  console.log(`符合條件的待辦：${todos.length} 件`);
  console.log("即將發送的訊息：\n" + message);

  await sendToDiscord(DISCORD_WEBHOOK_URL, message);
  console.log("✅ 已發送到 Discord。");
}

// 只有「直接執行這個檔案」時才跑 main()，被 import 測試時不會執行。
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("❌ 執行失敗：", err.message);
    process.exit(1);
  });
}
