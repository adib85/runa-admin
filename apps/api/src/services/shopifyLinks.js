/**
 * Build the Shopify theme editor URL for a merchant, opened on the
 * "App embeds" tab. Clicking this drops the merchant on the screen where
 * they toggle Runa AI Stylist on and click Save.
 *
 * Pure function — no Shopify API call required.
 */
export function getThemeEditorUrl(shop) {
  if (!shop) return null;
  return `https://${shop}/admin/themes/current/editor?context=apps`;
}

export default { getThemeEditorUrl };
