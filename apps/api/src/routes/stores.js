import { Router } from "express";
import { dynamodb, neo4j } from "@runa/core";
import { authenticate } from "../middleware/auth.js";
import { asyncHandler, ApiError } from "../middleware/error.js";

const router = Router();

router.use(authenticate);

/**
 * Project the user row into the "store" shape the frontend expects.
 * Each user row IS one store (1:1 with the Shopify install row), so this
 * just lifts the relevant top-level fields.
 */
function buildStoreView(user) {
  if (!user) return null;
  return {
    id: user.id,
    platform: (user.platform || "shopify").toLowerCase(),
    domain: user.websiteDomain || user.shop,
    name: user.storeName || (user.shop || "").split(".")[0],
    status: user.status || (user.password ? "active" : "pending"),
    productsCount: user.productsCount ?? user.totalProducts ?? 0,
    lastSync: user.lastSync || user.syncStatus?.lastUpdated || null,
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
    vtexApiKey: user.vtexApiKey || undefined,
    vtexToken: user.vtexToken || undefined
  };
}

/**
 * GET /api/stores
 * Returns the current user's single store. The response keeps a `stores: [..]`
 * array (with one entry) for backward compatibility with the existing UI.
 */
router.get("/", asyncHandler(async (req, res) => {
  const user = await dynamodb.users.getUserById(req.user.userId);
  if (!user) throw ApiError.notFound("User not found");

  const store = buildStoreView(user);
  res.json({
    store,
    stores: store ? [store] : [],
    shop: user.shop || null,
    websiteDomain:
      user.websiteDomain || user.domain || user.shopDomain || user.shop || null,
    accessToken:
      (user.platform || "").toLowerCase() === "shopify" ? user.accessToken : null
  });
}));

/**
 * GET /api/stores/:storeId
 * Each user has exactly one store (their own row), so storeId is essentially
 * a routing param — we ignore it and return the current user's store. This
 * keeps the existing frontend routes (`/stores/:storeId`) working unchanged.
 */
router.get("/:storeId", asyncHandler(async (req, res) => {
  const user = await dynamodb.users.getUserById(req.user.userId);
  if (!user) throw ApiError.notFound("User not found");

  const store = buildStoreView(user);
  if (!store) throw ApiError.notFound("Store not found");

  // Optionally enrich with a fresh Neo4j product count.
  try {
    if (store.domain) {
      store.productsCount = await neo4j.products.countProductsByStore(store.domain);
    }
  } catch (err) {
    // Non-fatal — keep the projected count.
  }

  res.json({ ...store, accessToken: undefined });
}));

/**
 * PUT /api/stores/:storeId
 * Update editable store-level fields on the current user's row.
 */
router.put("/:storeId", asyncHandler(async (req, res) => {
  const { name, accessToken } = req.body;

  const user = await dynamodb.users.getUserById(req.user.userId);
  if (!user) throw ApiError.notFound("User not found");

  if (typeof name === "string" && name.trim()) {
    user.storeName = name.trim();
  }
  if (typeof accessToken === "string" && accessToken.trim()) {
    user.accessToken = accessToken.trim();
  }
  user.updatedAt = new Date().toISOString();

  await dynamodb.users.saveUser(user);

  res.json({
    message: "Store updated successfully",
    store: { ...buildStoreView(user), accessToken: undefined }
  });
}));

/**
 * GET /api/stores/:storeId/categories
 * List Neo4j categories for the user's store domain.
 */
router.get("/:storeId/categories", asyncHandler(async (req, res) => {
  const user = await dynamodb.users.getUserById(req.user.userId);
  if (!user) throw ApiError.notFound("User not found");

  const store = buildStoreView(user);
  if (!store?.domain) throw ApiError.notFound("Store not found");

  const categories = await neo4j.categories.getCategoriesByStore(store.domain);
  res.json({ categories });
}));

export default router;
