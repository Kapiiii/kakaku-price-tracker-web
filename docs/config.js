// ブラウザ向けの公開用接続情報。管理用の秘密鍵はここに置かないでください。
export const CONFIG = Object.freeze({
  supabaseUrl: "https://nicgbsemqltpxyvyoslk.supabase.co",
  publishableKey: "sb_publishable_D7bf0bWgroS5ArGP2MU6RQ_itzUtVR-",
  siteUrl: "https://kapiiii.github.io/kakaku-price-tracker-web/",
});

export const authStorageKey = `sb-${new URL(CONFIG.supabaseUrl).hostname.split(".")[0]}-auth-token`;

export function needsAuthClient() {
  const callback = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.slice(1));
  if (callback.has("code") || callback.has("error") || hash.has("access_token") || hash.has("error")) {
    return true;
  }
  try {
    return Boolean(localStorage.getItem(authStorageKey));
  } catch {
    return true;
  }
}
