"use strict";

/* ==========================================================================
 * Service Worker — 基本的 App Shell 快取
 * --------------------------------------------------------------------------
 * 目的很單純：讓「開啟這個 PWA」這件事更快、更穩定，
 * 並且離線時至少能看到介面外殼，不會整頁空白。
 *
 * 這裡「不」處理：
 *   - Supabase 的資料讀寫（待辦事項、登入）：這些一定要有網路才能動作，
 *     不在這個 Service Worker 的快取範圍內，離線時該功能就是無法使用。
 *   - 跨來源的 CDN 資源（Supabase SDK、marked、DOMPurify、Google Fonts）：
 *     直接放行給瀏覽器自己處理，不額外攔截快取，避免版本管理變複雜。
 *
 * 快取策略：
 *   - App Shell（index.html / style.css / script.js / config.js /
 *     manifest.json / icons）：cache-first，有快取就直接用（最快），
 *     背景不做更新；要更新快取內容時，把下面的 CACHE_NAME 版本號 +1，
 *     舊快取會在 activate 階段被清掉，瀏覽器下次載入就會抓新的一份。
 *   - 導覽（頁面）請求離線且沒有快取可用時，退回快取中的 index.html，
 *     至少顯示介面外殼，而不是瀏覽器的離線錯誤頁。
 *   - 其他（跨來源）請求：不攔截，直接交給網路。
 *
 * 除了快取之外，這裡還處理 Web Push：
 *   - push：收到推播時顯示系統通知。
 *   - notificationclick：點擊通知後開啟／聚焦 App，並切到待辦一覽畫面。
 * ========================================================================== */

// 每次調整下面 APP_SHELL 清單或快取邏輯時，把版本號 +1，
// 讓使用者的瀏覽器建立新的快取、清掉舊的。
const CACHE_NAME = "schedule-todo-shell-v15";

// 需要跟 index.html 裡的 ?v=N 保持一致，否則快取到的會是舊版檔案。
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css?v=27",
  "./config.js?v=27",
  "./script.js?v=27",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  // Mia（AI 助理）的頭像。兩種尺寸都快取：由 srcset 依螢幕密度挑一張，
  // 事先不知道使用者的裝置會選哪一張，離線時兩張都要拿得到。
  "./icons/mia-avatar-96.png",
  "./icons/mia-avatar-192.png",
  // 底部導航列的手繪風圖示。雖然目前是以 inline SVG 嵌在 index.html 裡
  // （才能用 currentColor 換色），這裡仍一併快取原始檔，讓它們離線可用、
  // 之後若改成外部引用也不會漏掉。
  "./icons/icon-calendar-check.svg",
  "./icons/icon-notebook.svg",
  "./icons/icon-list.svg",
  "./icons/icon-moon.svg",
  "./icons/icon-logout.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // cache: "reload" 讓這次抓取略過瀏覽器自己的 HTTP 快取。
      // 沒有這個的話，像 icons/*.png 這種「檔名不變、內容換掉」的資源，
      // 即使升了 CACHE_NAME，install 時仍可能從 HTTP 快取撈到舊圖，
      // 等於白升一版。（?v=N 只掛在 css/js 上，對圖示沒有作用。）
      .then((cache) =>
        cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: "reload" })))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // 只處理 GET，且只處理自己網域的請求；跨來源（CDN、Supabase API）一律放行。
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request).catch(() => {
        // 離線且沒有對應快取：導覽請求就退回 index.html（顯示介面外殼），
        // 其他請求（例如漏抓的圖片）就讓它失敗，不硬湊內容。
        if (request.mode === "navigate") {
          return caches.match("./index.html");
        }
        return undefined;
      });
    })
  );
});

/* ==========================================================================
 * Web Push
 * --------------------------------------------------------------------------
 * 每天早上由 GitHub Actions（scripts/daily-reminder.mjs）用 web-push 發送，
 * 內容是一段已加密的 JSON：{ title, body, url }。
 * ========================================================================== */

// 點擊通知後要前往的位置。用 hash 而不是查詢字串：
//   - hash 不會進入 HTTP 請求，也不影響 Cache API 的比對鍵，
//     '#todos' 仍然命中快取中的 './index.html'，離線一樣打得開。
//   - 查詢字串（?view=todos）會讓 caches.match() 找不到對應項目，
//     除非另外開 ignoreSearch，反而把快取邏輯弄複雜。
// script.js 讀完這個 hash 後會立刻用 replaceState 清掉，只作用一次。
const NOTIFICATION_URL = "./index.html#todos";

// 同一個 tag 的通知會互相取代，避免連續幾天沒點開就在通知中心疊成一整排。
const NOTIFICATION_TAG = "daily-reminder";

self.addEventListener("push", (event) => {
  // 沒有 payload、或 payload 不是預期的 JSON 時仍要顯示通知：
  // 有些推播服務會送出不帶內容的「喚醒」訊息，而規範要求
  // push 事件收到後一定要顯示一則通知，靜默吃掉會被瀏覽器警告
  // （甚至撤銷推播權限），所以這裡一律退回一組預設文案。
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (_) {
      payload = { body: event.data.text() };
    }
  }

  const title = payload.title || "今天的待辦提醒";
  const options = {
    body: payload.body || "打開看看今天有什麼要做的吧",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag: NOTIFICATION_TAG,
    renotify: true,
    // 帶著要開啟的位置，讓 notificationclick 不用再猜。
    data: { url: payload.url || NOTIFICATION_URL },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = new URL(
    (event.notification.data && event.notification.data.url) || NOTIFICATION_URL,
    self.location.href
  );

  event.waitUntil(
    (async () => {
      // includeUncontrolled: true 很重要——App 可能是在這個 Service Worker
      // 取得控制權之前就開好的（例如剛更新完版本），少了它會找不到那些分頁，
      // 結果每次點通知都多開一個視窗。
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // 已經開著就聚焦既有分頁，不要開新視窗。
      for (const client of clientList) {
        if (new URL(client.url).origin !== targetUrl.origin) continue;
        await client.focus();
        // 分頁已經載入過了，改用訊息通知它切到待辦一覽——
        // 這時候改 hash 不會觸發任何重新載入，光靠網址是叫不動畫面的。
        client.postMessage({ type: "navigate", view: "todos" });
        return;
      }

      // 沒有開著的分頁才開新視窗，網址帶 #todos，
      // script.js 載入時會讀到並直接切到待辦一覽。
      await self.clients.openWindow(targetUrl.href);
    })()
  );
});
