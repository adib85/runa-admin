import { Router } from "express";
import { dynamodb } from "@runa/core";
import { authenticate } from "../middleware/auth.js";
import { asyncHandler, ApiError } from "../middleware/error.js";
import { getThemeEditorUrl } from "../services/shopifyLinks.js";
import { checkAppEmbedEnabled } from "../services/checkAppEmbed.js";

const router = Router();

router.use(authenticate);

// In-memory cache of the embed status per shop. Theme settings change rarely;
// we don't want to hit Shopify on every Home page load.
const EMBED_TTL_MS = 5 * 60 * 1000; // 5 minutes
const embedCache = new Map(); // shop -> { value, expiresAt }

function getCachedEmbed(shop) {
  const entry = embedCache.get(shop);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    embedCache.delete(shop);
    return null;
  }
  return entry.value;
}

function setCachedEmbed(shop, value) {
  embedCache.set(shop, { value, expiresAt: Date.now() + EMBED_TTL_MS });
}

function invalidateEmbed(shop) {
  embedCache.delete(shop);
}

/**
 * GET /api/onboarding/status
 *
 * Single endpoint the Home page calls to know which onboarding steps are
 * actually done. Truth comes from real signals — DynamoDB row + Shopify
 * Admin API — not from localStorage clicks.
 *
 * Query: ?refresh=1  bypasses the embed-status cache (use after the merchant
 *                    just toggled the embed in the theme editor).
 *
 * Response shape:
 * {
 *   shop, domain, platform,
 *   themeEditorUrl,           // deterministic URL for the App embeds tab
 *   connectShopify: { done }, // shop row exists + accessToken present
 *   enableAIStylist: {        // app embed actually toggled on in published theme
 *     done, themeId, themeName, blockKey, blockType, reason
 *   }
 * }
 */
router.get("/status", asyncHandler(async (req, res) => {
  const user = await dynamodb.users.getUserById(req.user.userId);
  if (!user) throw ApiError.notFound("User not found");

  const shop = user.shop || null;
  const domain = user.domain || user.shop || null;
  const platform = (user.platform || "").toLowerCase();
  const isShopify = platform === "shopify";
  const hasAccessToken = Boolean(user.accessToken);
  const refresh = req.query.refresh === "1" || req.query.refresh === "true";

  const result = {
    shop,
    domain,
    platform,
    themeEditorUrl: shop ? getThemeEditorUrl(shop) : null,
    connectShopify: {
      done: isShopify && hasAccessToken
    },
    enableAIStylist: {
      done: false,
      reason: !isShopify
        ? "not-shopify"
        : !hasAccessToken
          ? "shop-not-connected"
          : "not-checked"
    }
  };

  // Only check the theme embed if there's a shop + accessToken to read with.
  if (isShopify && hasAccessToken) {
    let embed = refresh ? null : getCachedEmbed(shop);
    if (!embed) {
      try {
        embed = await checkAppEmbedEnabled({ shop, accessToken: user.accessToken });
        setCachedEmbed(shop, embed);
      } catch (err) {
        console.error("Embed status check failed:", err.message);
        embed = { isActive: false, reason: "check-failed" };
      }
    }
    result.enableAIStylist = { done: embed.isActive, ...embed };
  }

  res.json(result);
}));

/**
 * POST /api/onboarding/recheck
 * Convenience endpoint that invalidates the embed cache for the merchant's
 * shop. Call this right after the merchant clicks "Open theme editor" so
 * the next /status hit reflects whatever they just did.
 */
router.post("/recheck", asyncHandler(async (req, res) => {
  const user = await dynamodb.users.getUserById(req.user.userId);
  if (user?.shop) invalidateEmbed(user.shop);
  res.json({ ok: true });
}));

export default router;
