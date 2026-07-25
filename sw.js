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
 * ========================================================================== */

// 每次調整下面 APP_SHELL 清單或快取邏輯時，把版本號 +1，
// 讓使用者的瀏覽器建立新的快取、清掉舊的。
const CACHE_NAME = "schedule-todo-shell-v1";

// 需要跟 index.html 裡的 ?v=N 保持一致，否則快取到的會是舊版檔案。
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css?v=14",
  "./config.js?v=14",
  "./script.js?v=14",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
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
