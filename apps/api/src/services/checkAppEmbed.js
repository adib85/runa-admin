import fetch from "node-fetch";

const SHOPIFY_API_VERSION = "2025-10";
// Match by app handle so we don't false-positive on other apps that happen to
// name their embed block "app-embed" (e.g. amp-back-in-stock). The block file
// in the repo is extensions/runa-ai/blocks/app-embed.liquid, but the app
// handle wrapping it on the live store has varied across dev/prod versions
// — keep all known Runa handles here.
const RUNA_APP_HANDLES = ["runa-ai-stylist", "runa-ai", "runa-ai-assistant"];
const RUNA_APP_EMBED_PREFIXES = RUNA_APP_HANDLES.map(
  (h) => `shopify://apps/${h}/blocks/app-embed/`
);

function isRunaAppEmbedType(type) {
  if (typeof type !== "string") return false;
  return RUNA_APP_EMBED_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/**
 * Returns whether the Runa AI Stylist app embed is currently enabled in
 * the merchant's PUBLISHED theme.
 *
 *   { isActive: true,  themeId, themeName, blockKey, blockType }
 *   { isActive: false, themeId, themeName, reason }
 *
 * @param {Object} args
 * @param {string} args.shop          e.g. "andreearaicu.myshopify.com"
 * @param {string} args.accessToken   Shopify Admin API access token
 */
export async function checkAppEmbedEnabled({ shop, accessToken }) {
  if (!shop) throw new Error("shop is required");
  if (!accessToken) throw new Error("accessToken is required");

  // 1. Find the published (MAIN) theme.
  const themesRes = await shopifyFetch(
    shop,
    accessToken,
    `/admin/api/${SHOPIFY_API_VERSION}/themes.json?role=main&fields=id,name,role`
  );
  const mainTheme = themesRes?.themes?.[0];
  if (!mainTheme) {
    return { isActive: false, themeId: null, reason: "no-main-theme" };
  }

  // 2. Read config/settings_data.json from that theme.
  const assetRes = await shopifyFetch(
    shop,
    accessToken,
    `/admin/api/${SHOPIFY_API_VERSION}/themes/${mainTheme.id}/assets.json` +
      `?asset[key]=config/settings_data.json`
  );
  const raw = assetRes?.asset?.value;
  if (!raw) {
    return {
      isActive: false,
      themeId: mainTheme.id,
      themeName: mainTheme.name,
      reason: "no-settings-data"
    };
  }

  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    return {
      isActive: false,
      themeId: mainTheme.id,
      themeName: mainTheme.name,
      reason: "settings-parse-error"
    };
  }

  // 3. Find a Runa app embed block in current.blocks; check `disabled`.
  const blocks = settings?.current?.blocks ?? {};
  const entry = Object.entries(blocks).find(([, b]) =>
    isRunaAppEmbedType(b?.type)
  );
  if (!entry) {
    return {
      isActive: false,
      themeId: mainTheme.id,
      themeName: mainTheme.name,
      reason: "block-not-installed"
    };
  }

  const [blockKey, block] = entry;
  if (block.disabled === true) {
    return {
      isActive: false,
      themeId: mainTheme.id,
      themeName: mainTheme.name,
      blockKey,
      blockType: block.type,
      reason: "block-disabled"
    };
  }

  return {
    isActive: true,
    themeId: mainTheme.id,
    themeName: mainTheme.name,
    blockKey,
    blockType: block.type
  };
}

async function shopifyFetch(shop, accessToken, path) {
  const res = await fetch(`https://${shop}${path}`, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json"
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Shopify ${res.status} ${path}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export default { checkAppEmbedEnabled };
