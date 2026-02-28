import { Router } from "express";
import { dynamodb, neo4j } from "@runa/core";
import { authenticate } from "../middleware/auth.js";
import { asyncHandler, ApiError } from "../middleware/error.js";

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * GET /api/products
 * List products for a store
 */
router.get("/", asyncHandler(async (req, res) => {
  const { storeId, category, skip = 0, limit = 50 } = req.query;

  if (!storeId) {
    throw ApiError.badRequest("storeId query parameter is required");
  }

  // Verify user owns this store
  const user = await dynamodb.users.getUserById(req.user.userId);
  const store = (user?.stores || []).find(s => s.id === storeId);
  if (!store) {
    throw ApiError.notFound("Store not found");
  }

  let products;
  if (category) {
    products = await neo4j.categories.getProductsByCategory(
      store.domain,
      category,
      { skip: parseInt(skip), limit: parseInt(limit) }
    );
  } else {
    products = await neo4j.products.getProductsByStore(
      store.domain,
      { skip: parseInt(skip), limit: parseInt(limit) }
    );
  }

  const total = await neo4j.products.countProductsByStore(store.domain);

  res.json({
    products,
    pagination: {
      skip: parseInt(skip),
      limit: parseInt(limit),
      total
    }
  });
}));

/**
 * GET /api/products/:productId
 * Get single product details
 */
router.get("/:productId", asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const { storeId } = req.query;

  if (!storeId) {
    throw ApiError.badRequest("storeId query parameter is required");
  }

  // Verify user owns this store
  const user = await dynamodb.users.getUserById(req.user.userId);
  const store = (user?.stores || []).find(s => s.id === storeId);
  if (!store) {
    throw ApiError.notFound("Store not found");
  }

  const product = await neo4j.products.getProduct(productId);
  if (!product) {
    throw ApiError.notFound("Product not found");
  }

  res.json({ product });
}));

/**
 * POST /api/products/search
 * Search products by embedding similarity
 */
router.post("/search", asyncHandler(async (req, res) => {
  const { storeId, query, limit = 10 } = req.body;

  if (!storeId || !query) {
    throw ApiError.badRequest("storeId and query are required");
  }

  // Verify user owns this store
  const user = await dynamodb.users.getUserById(req.user.userId);
  const store = (user?.stores || []).find(s => s.id === storeId);
  if (!store) {
    throw ApiError.notFound("Store not found");
  }

  // Generate embedding for query
  const { ai } = await import("@runa/core");
  const queryEmbedding = await ai.embeddings.generateEmbedding(query);

  if (!queryEmbedding) {
    throw ApiError.badRequest("Failed to process search query");
  }

  // Search by embedding
  const results = await neo4j.products.searchByEmbedding(
    store.domain,
    queryEmbedding,
    parseInt(limit)
  );

  res.json({
    results: results.map(r => ({
      ...r.product,
      score: r.score
    }))
  });
}));

/**
 * GET /api/products/stats/:storeId
 * Get product statistics for a store
 */
router.get("/stats/:storeId", asyncHandler(async (req, res) => {
  const { storeId } = req.params;

  // Verify user owns this store
  const user = await dynamodb.users.getUserById(req.user.userId);
  const store = (user?.stores || []).find(s => s.id === storeId);
  if (!store) {
    throw ApiError.notFound("Store not found");
  }

  const totalProducts = await neo4j.products.countProductsByStore(store.domain);
  const categories = await neo4j.categories.getCategoriesByStore(store.domain);

  res.json({
    totalProducts,
    totalCategories: categories.length,
    categories: categories.slice(0, 10), // Top 10 categories
    lastSync: store.lastSync
  });
}));

export default router;
