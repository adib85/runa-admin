import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { dynamodb, neo4j } from "@runa/core";
import { authenticate } from "../middleware/auth.js";
import { asyncHandler, ApiError } from "../middleware/error.js";

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * GET /api/stores
 * List all stores for the current user
 */
router.get("/", asyncHandler(async (req, res) => {
  const user = await dynamodb.users.getUserById(req.user.userId);

  if (!user) {
    throw ApiError.notFound("User not found");
  }

  const stores = user.stores || [];

  // Also return shop field for Lambda API calls (e.g., runa-ai-fashion.myshopify.com)
  // For Shopify stores, also return the accessToken (for display/editing in admin)
  res.json({ 
    stores,
    shop: user.shop || null,
    accessToken: user.platform?.toLowerCase() === 'shopify' ? user.accessToken : null
  });
}));

/**
 * POST /api/stores
 * Add a new store
 */
router.post("/", asyncHandler(async (req, res) => {
  const { platform, domain, accessToken, name } = req.body;

  if (!platform || !domain || !accessToken) {
    throw ApiError.badRequest("Platform, domain, and accessToken are required");
  }

  // Validate platform
  const validPlatforms = ["shopify", "woocommerce", "vtex", "custom"];
  if (!validPlatforms.includes(platform.toLowerCase())) {
    throw ApiError.badRequest(`Invalid platform. Must be one of: ${validPlatforms.join(", ")}`);
  }

  // Get user
  const user = await dynamodb.users.getUserById(req.user.userId);
  if (!user) {
    throw ApiError.notFound("User not found");
  }

  // Check if store already exists
  const existingStore = (user.stores || []).find(s => s.domain === domain);
  if (existingStore) {
    throw ApiError.conflict("Store already exists");
  }

  // Create store object
  const store = {
    id: uuidv4(),
    platform: platform.toLowerCase(),
    domain,
    accessToken, // TODO: Encrypt this
    name: name || domain,
    status: "pending",
    productsCount: 0,
    lastSync: null,
    createdAt: new Date().toISOString()
  };

  // Add to user's stores
  if (!user.stores) user.stores = [];
  user.stores.push(store);

  await dynamodb.users.saveUser(user);

  // Create in Neo4j
  await neo4j.applications.createApplicationAndStore(
    { id: domain, storeName: name || domain },
    { id: "runa", appName: "Runa" }
  );

  res.status(201).json({
    message: "Store added successfully",
    store: {
      id: store.id,
      platform: store.platform,
      domain: store.domain,
      name: store.name,
      status: store.status
    }
  });
}));

/**
 * GET /api/stores/:storeId
 * Get store details
 */
router.get("/:storeId", asyncHandler(async (req, res) => {
  const { storeId } = req.params;

  const user = await dynamodb.users.getUserById(req.user.userId);
  if (!user) {
    throw ApiError.notFound("User not found");
  }

  const store = (user.stores || []).find(s => s.id === storeId);
  if (!store) {
    throw ApiError.notFound("Store not found");
  }

  // Get product count from Neo4j
  const productCount = await neo4j.products.countProductsByStore(store.domain);

  res.json({
    ...store,
    productsCount: productCount,
    accessToken: undefined // Don't expose token
  });
}));

/**
 * PUT /api/stores/:storeId
 * Update store settings
 */
router.put("/:storeId", asyncHandler(async (req, res) => {
  const { storeId } = req.params;
  const { name, accessToken } = req.body;

  const user = await dynamodb.users.getUserById(req.user.userId);
  if (!user) {
    throw ApiError.notFound("User not found");
  }

  const storeIndex = (user.stores || []).findIndex(s => s.id === storeId);
  if (storeIndex === -1) {
    throw ApiError.notFound("Store not found");
  }

  // Update fields
  if (name) user.stores[storeIndex].name = name;
  if (accessToken) user.stores[storeIndex].accessToken = accessToken;
  user.stores[storeIndex].updatedAt = new Date().toISOString();

  await dynamodb.users.saveUser(user);

  res.json({
    message: "Store updated successfully",
    store: {
      ...user.stores[storeIndex],
      accessToken: undefined
    }
  });
}));

/**
 * DELETE /api/stores/:storeId
 * Remove a store
 */
router.delete("/:storeId", asyncHandler(async (req, res) => {
  const { storeId } = req.params;

  const user = await dynamodb.users.getUserById(req.user.userId);
  if (!user) {
    throw ApiError.notFound("User not found");
  }

  const storeIndex = (user.stores || []).findIndex(s => s.id === storeId);
  if (storeIndex === -1) {
    throw ApiError.notFound("Store not found");
  }

  const store = user.stores[storeIndex];

  // Remove from user's stores
  user.stores.splice(storeIndex, 1);
  await dynamodb.users.saveUser(user);

  // Optionally delete from Neo4j (commented out for safety)
  // await neo4j.applications.deleteStore(store.domain);

  res.json({ message: "Store removed successfully" });
}));

/**
 * GET /api/stores/:storeId/categories
 * Get categories for a store
 */
router.get("/:storeId/categories", asyncHandler(async (req, res) => {
  const { storeId } = req.params;

  const user = await dynamodb.users.getUserById(req.user.userId);
  if (!user) {
    throw ApiError.notFound("User not found");
  }

  const store = (user.stores || []).find(s => s.id === storeId);
  if (!store) {
    throw ApiError.notFound("Store not found");
  }

  const categories = await neo4j.categories.getCategoriesByStore(store.domain);

  res.json({ categories });
}));

export default router;
