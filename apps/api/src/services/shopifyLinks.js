import { config } from "@runa/config";

/**
 * Build the Shopify theme editor URL for a merchant. Lands them on the
 * "App embeds" tab with the Runa AI Stylist embed *pre-toggled on* — all
 * the merchant has to do is click Save.
 *
 * Shopify supports the `activateAppId=<APP_API_KEY>/<HANDLE>` query param
 * for this. APP_API_KEY = the Runa Shopify app's Client ID; HANDLE = the
 * embed block file name (without `.liquid`).
 *
 * Pure function — no Shopify API call required.
 */
export function getThemeEditorUrl(shop) {
  if (!shop) return null;
  const base = `https://${shop}/admin/themes/current/editor?context=apps`;
  const appKey = config.shopify?.appKey;
  const handle = config.shopify?.appEmbedHandle;
  if (appKey && handle) {
    return `${base}&activateAppId=${encodeURIComponent(appKey)}/${encodeURIComponent(handle)}`;
  }
  return base;
}

export default { getThemeEditorUrl };
