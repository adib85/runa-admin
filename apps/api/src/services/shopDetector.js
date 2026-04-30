import fetch from "node-fetch";

const FETCH_TIMEOUT_MS = 6000;

/**
 * Strip protocol, www., trailing slashes/paths, lowercase the domain.
 */
export function normalizeDomain(rawUrl) {
  if (!rawUrl) return "";
  let v = String(rawUrl).trim().toLowerCase();
  v = v.replace(/^https?:\/\//, "");
  v = v.replace(/^www\./, "");
  v = v.split("/")[0];
  v = v.replace(/\/+$/, "");
  return v;
}

/**
 * Try to extract the canonical Shopify shop domain from a storefront HTML page.
 * Returns the *.myshopify.com domain if the site is identifiable as Shopify,
 * otherwise null.
 */
async function detectShopifyShop(domain) {
  if (!domain) return null;

  // If already a *.myshopify.com URL, just return it.
  if (domain.endsWith(".myshopify.com")) return domain;

  const tryFetch = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          // Shopify storefronts sometimes serve a different page to bots; pretend to be a browser.
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "text/html,*/*;q=0.8"
        }
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // Try https first, then http as a fallback.
  const html =
    (await tryFetch(`https://${domain}/`)) ||
    (await tryFetch(`http://${domain}/`));
  if (!html) return null;

  // 1) Inline JS variable: Shopify.shop = "andreearaicu.myshopify.com";
  const m1 = html.match(/Shopify\.shop\s*=\s*["']([\w.-]+\.myshopify\.com)["']/i);
  if (m1) return m1[1].toLowerCase();

  // 2) shopify-checkout-api-token meta or other myshopify references in HTML.
  const m2 = html.match(/([\w-]+\.myshopify\.com)/i);
  if (m2) return m2[1].toLowerCase();

  // 3) Last-resort heuristics: clearly a Shopify-built site but no domain found.
  const looksLikeShopify =
    /cdn\.shopify\.com|shopify-section|shopify\.theme|<meta[^>]+name=["']generator["'][^>]+content=["']Shopify/i.test(
      html
    );
  if (looksLikeShopify) {
    // We know it's Shopify but couldn't resolve the handle; fall back to the
    // entered domain prefixed with the apex so caller can still use it.
    return null;
  }

  return null;
}

/**
 * Build the DynamoDB partition key from a shop value, matching the format the
 * Shopify install side uses: `offline_<shop>` (e.g. offline_andreearaicu.myshopify.com).
 */
export function shopToId(shop) {
  if (!shop) return "";
  const s = String(shop).trim().toLowerCase();
  return s.startsWith("offline_") ? s : `offline_${s}`;
}

/**
 * Resolve any user-entered URL to canonical identifiers for DynamoDB:
 *   - shop:   real *.myshopify.com when the store is on Shopify, else "custom.<domain>"
 *   - id:     "offline_<shop>" — matches the Shopify install row's partition key
 *
 * @param {string} rawUrl
 * @returns {Promise<{ id: string, shop: string, platform: 'shopify'|'custom', domain: string }>}
 */
export async function resolveShopId(rawUrl) {
  const domain = normalizeDomain(rawUrl);
  if (!domain) {
    throw new Error("Invalid URL");
  }

  const shopifyShop = await detectShopifyShop(domain);
  if (shopifyShop) {
    return {
      id: shopToId(shopifyShop),
      shop: shopifyShop,
      platform: "shopify",
      domain
    };
  }

  const customShop = `custom.${domain}`;
  return {
    id: shopToId(customShop),
    shop: customShop,
    platform: "custom",
    domain
  };
}

export default { resolveShopId, normalizeDomain, shopToId };
