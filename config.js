"use strict";

/* ==========================================================================
 * Supabase 連線設定
 * --------------------------------------------------------------------------
 * 這裡放的是 Supabase 的 Project URL 與「publishable（可發佈）金鑰」。
 *
 * 為什麼可以直接寫在前端？
 *   - publishable / anon key 是「設計上就可以公開」的金鑰，它本身沒有繞過
 *     權限的能力，真正保護資料的是 Supabase 的 Row Level Security (RLS) 政策。
 *   - 這與「service_role 金鑰」完全不同 —— service_role 可以繞過所有 RLS，
 *     「絕對不能」寫在前端或提交進 git，否則任何人都能讀寫整個資料庫。
 *
 * 換句話說：安全性不是靠把這把 key 藏起來，而是靠資料表上正確的 RLS 政策
 * （見 PR 說明與 README 中的 SQL 設定）。
 * ========================================================================== */

window.APP_CONFIG = {
  SUPABASE_URL: "https://qvokiftcyeptmokvrxcp.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_JeBElRNREZpvpJiH5eGHSw_d3h6cFOC",

  /* ------------------------------------------------------------------------
   * Web Push 的 VAPID 公鑰（base64url 字串，約 87 個字元）
   * ------------------------------------------------------------------------
   * ⚠️ 這裡要填的是「公鑰」。公鑰本來就會隨著訂閱請求送到推播服務，
   *    公開沒有問題；「私鑰」則存在 GitHub Secrets 的 VAPID_PRIVATE_KEY，
   *    只有發送推播的 GitHub Actions 用得到，絕對不要放進這個檔案。
   *
   * 留空時，抽屜裡的「每日提醒」開關會自動停用並顯示「尚未設定推播金鑰」，
   * 不會拋錯，也不會去要通知權限。填好之後重新整理就會啟用。
   * ---------------------------------------------------------------------- */
  VAPID_PUBLIC_KEY: "window.APP_CONFIG.VAPID_PUBLIC_KEY",
};
