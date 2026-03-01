/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * VTEX PROVIDER - Product Sync Implementation
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * VTEX API Documentation: https://developers.vtex.com/docs/api-reference/catalog-api
 * 
 * ─────────────────────────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────────
 * 
 * From command line (in apps/api directory):
 * 
 *   node src/scripts/sync-modular.js vtex <account-name> <app-key> <app-token> [--force]
 * 
 * Examples:
 *   node src/scripts/sync-modular.js vtex toffro vtexappkey-toffro-XXXX TOKENVALUE
 *   node src/scripts/sync-modular.js vtex toffro vtexappkey-toffro-XXXX TOKENVALUE --force
 * 
 * ─────────────────────────────────────────────────────────────────────────────────
 * REQUIRED CREDENTIALS
 * ─────────────────────────────────────────────────────────────────────────────────
 * 
 * Get these from VTEX Admin → Account Settings → Account Management → Application Keys
 * 
 * | Parameter    | Description                                    | Example                    |
 * |--------------|------------------------------------------------|----------------------------|
 * | accountName  | VTEX account name (subdomain)                  | toffro                     |
 * | appKey       | X-VTEX-API-AppKey header value                 | vtexappkey-account-XXXXX   |
 * | appToken     | X-VTEX-API-AppToken header value               | BUWVNSSF...                |
 * | environment  | API environment (optional)                     | vtexcommercestable         |
 * 
 * ─────────────────────────────────────────────────────────────────────────────────
 * SYNC PROCESS FLOW
 * ─────────────────────────────────────────────────────────────────────────────────
 * 
 * The sync process follows these steps:
 * 
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ STEP 1: INITIALIZATION                                                      │
 * │   - Parse CLI arguments (accountName, appKey, appToken, --force)            │
 * │   - Create VtexProvider instance with credentials                           │
 * │   - Initialize stats tracking (totalFetched, available, outOfStock, noPrice)│
 * └─────────────────────────────────────────────────────────────────────────────┘
 *                                       ↓
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ STEP 2: CREATE APPLICATION & STORE IN NEO4J                                 │
 * │   - MERGE (app:Application {id: "runa"})                                    │
 * │   - MERGE (store:Store {id: "toffro.vtexcommercestable.com.br"})           │
 * │   - CREATE relationship (app)-[:HAS_STORE]->(store)                         │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *                                       ↓
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ STEP 3: FETCH & SAVE CATEGORIES                                             │
 * │   - GET /api/catalog_system/pub/category/tree/3                             │
 * │   - Flatten nested category tree                                            │
 * │   - Save to Neo4j as Category nodes                                         │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *                                       ↓
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ STEP 4: FETCH PRODUCTS (paginated, 50 per batch)                            │
 * │   - GET /api/catalog_system/pub/products/search?_from=0&_to=49              │
 * │   - For each product in batch:                                              │
 * │       ├─ Check availability: items[].sellers[].commertialOffer.IsAvailable  │
 * │       ├─ Check price: items[].sellers[].commertialOffer.Price > 0           │
 * │       ├─ If available && hasPrice → add to processing queue                 │
 * │       └─ If not → skip and log reason (out_of_stock / no_price)             │
 * │   - Continue fetching until no more products (hasNextPage = false)          │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *                                       ↓
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ STEP 5: CHECK EXISTING PRODUCTS (skip if --force)                           │
 * │   - Query Neo4j for existing product IDs in this store                      │
 * │   - Filter out already-indexed products (unless --force flag)               │
 * │   - Only process NEW products to save API calls and time                    │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *                                       ↓
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ STEP 6: PROCESS EACH PRODUCT                                                │
 * │   For each available product:                                               │
 * │   ├─ Extract product properties using OpenAI (gpt-4o-mini)                  │
 * │   │   → { product, characteristics, color, material, demographic, category }│
 * │   ├─ Ensure Size/Color options exist on variants                            │
 * │   ├─ Generate embeddings (text-embedding-3-small):                          │
 * │   │   → titleEmbedding, contentEmbedding, productEmbedding                  │
 * │   │   → characteristicsEmbedding, categoryEmbedding, styleCodeEmbedding     │
 * │   │   → sizeEmbedding, colorEmbedding for each variant                      │
 * │   ├─ Determine category from collections or AI classification               │
 * │   └─ Transform to unified product format                                    │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *                                       ↓
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ STEP 7: SAVE TO NEO4J                                                       │
 * │   - Save products in batches with controlled concurrency (2 parallel)       │
 * │   - Create/update nodes: Product, Variant, Category, Demographic            │
 * │   - Create relationships:                                                   │
 * │       (Product)-[:HAS_VARIANT]->(Variant)                                   │
 * │       (Product)-[:HAS_CATEGORY]->(Category)                                 │
 * │       (Product)-[:HAS_DEMOGRAPHIC]->(Demographic)                           │
 * │       (Store)-[:HAS_PRODUCT]->(Product)                                     │
 * │   - Retry on deadlock with exponential backoff                              │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *                                       ↓
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ STEP 8: UPDATE PROGRESS                                                     │
 * │   - Publish progress to PubNub channel: {shopName}_scan                     │
 * │   - Update DynamoDB user record with syncProgress percentage                │
 * │   - Display: "Progress: 60/220 (27.3%)"                                     │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *                                       ↓
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ STEP 9: PROCESS CONTEXT                                                     │
 * │   - Fetch all categories from Neo4j for this store                          │
 * │   - Generate AI suggestions using OpenAI (conversation starters)            │
 * │   - Save context to DynamoDB user record                                    │
 * │   - Publish contextFetching status to PubNub                                │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *                                       ↓
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ STEP 10: LOG FINAL STATS                                                    │
 * │   ════════════════════════════════════════════════════════════              │
 * │   [VTEX] AVAILABILITY STATS:                                                │
 * │     Total fetched from API:    16,620                                       │
 * │     Available (indexed):       2,500 (15.0%)                                │
 * │     Out of stock (skipped):    14,000                                       │
 * │     No price (skipped):        120                                          │
 * │   ════════════════════════════════════════════════════════════              │
 * └─────────────────────────────────────────────────────────────────────────────┘
 * 
 * ─────────────────────────────────────────────────────────────────────────────────
 * AVAILABILITY FILTERING
 * ─────────────────────────────────────────────────────────────────────────────────
 * 
 * IMPORTANT: This provider only indexes AVAILABLE products!
 * 
 * VTEX catalogs often contain 85%+ out-of-stock products that are hidden from
 * users on the website. These are filtered out to:
 *   - Reduce Neo4j storage and query time
 *   - Save OpenAI API costs (no embeddings for unavailable products)
 *   - Ensure search results only show purchasable items
 * 
 * Availability check:
 *   product.items[].sellers[].commertialOffer.IsAvailable === true
 *   product.items[].sellers[].commertialOffer.Price > 0
 * 
 * A product is indexed if ANY SKU has ANY seller with IsAvailable=true AND Price>0
 * 
 * ─────────────────────────────────────────────────────────────────────────────────
 * VTEX API ENDPOINTS USED
 * ─────────────────────────────────────────────────────────────────────────────────
 * 
 * | Endpoint                                           | Purpose                    |
 * |----------------------------------------------------|----------------------------|
 * | /api/catalog_system/pub/products/search           | Fetch products (paginated) |
 * | /api/catalog_system/pub/category/tree/3           | Fetch category tree        |
 * 
 * Headers required:
 *   X-VTEX-API-AppKey: {appKey}
 *   X-VTEX-API-AppToken: {appToken}
 * 
 * ─────────────────────────────────────────────────────────────────────────────────
 * OPENAI API CALLS
 * ─────────────────────────────────────────────────────────────────────────────────
 * 
 * | Model                    | Purpose                        | Called When           |
 * |--------------------------|--------------------------------|-----------------------|
 * | text-embedding-3-small   | Generate vector embeddings     | For each product:     |
 * |                          | (1536 dimensions)              |  - titleEmbedding     |
 * |                          |                                |  - contentEmbedding   |
 * |                          |                                |  - productEmbedding   |
 * |                          |                                |  - characteristicsEmb |
 * |                          |                                |  - categoryEmbedding  |
 * |                          |                                |  - styleCodeEmbedding |
 * |                          |                                |  - sizeEmbedding (var)|
 * |                          |                                |  - colorEmbedding(var)|
 * |--------------------------|--------------------------------|-----------------------|
 * | gpt-4o-mini              | Extract product properties     | Once per product      |
 * |                          | Returns JSON:                  | (Step 6)              |
 * |                          |  - product (type)              |                       |
 * |                          |  - characteristics             |                       |
 * |                          |  - color                       |                       |
 * |                          |  - material                    |                       |
 * |                          |  - brand                       |                       |
 * |                          |  - demographic (woman/man)     |                       |
 * |                          |  - category                    |                       |
 * |--------------------------|--------------------------------|-----------------------|
 * | gpt-4o-mini              | Generate chat suggestions      | Once at end (Step 9)  |
 * |                          | Returns 3 conversation         |                       |
 * |                          | starters for the store         |                       |
 * 
 * API Cost Estimation (per 1000 products):
 *   - Embeddings: ~8 embeddings × 1000 products × ~100 tokens = ~800K tokens
 *   - Classification: ~1 call × 1000 products × ~500 tokens = ~500K tokens
 *   - Suggestions: 1 call × ~200 tokens = ~200 tokens
 * 
 * ─────────────────────────────────────────────────────────────────────────────────
 * DATA STORAGE
 * ─────────────────────────────────────────────────────────────────────────────────
 * 
 * | Service   | Purpose                                                          |
 * |-----------|------------------------------------------------------------------|
 * | Neo4j     | Products, Variants, Categories, Store relationships, embeddings |
 * | DynamoDB  | User sync progress, context, suggestions                        |
 * | PubNub    | Real-time sync progress notifications                           |
 * | OpenAI    | Product classification, embeddings generation                   |
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fetch from "node-fetch";
import { BaseProvider } from "./base.js";
import { delay } from "../utils/index.js";

export class VtexProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.accountName = config.accountName || config.shopName?.split('.')[0];
    this.appKey = config.appKey || config.accessToken;
    this.appToken = config.appToken || config.apiToken;
    this.environment = config.environment || "vtexcommercestable";
    
    // Base URL for VTEX API
    this.baseUrl = `https://${this.accountName}.${this.environment}.com.br`;
    
    // Default headers for all requests
    this.headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-VTEX-API-AppKey": this.appKey,
      "X-VTEX-API-AppToken": this.appToken
    };

    // Stats tracking
    this.stats = {
      totalFetched: 0,
      available: 0,
      outOfStock: 0,
      noPrice: 0
    };
  }

  get providerType() {
    return "VTEX";
  }

  /**
   * Make authenticated request to VTEX API with automatic retry on 429
   */
  async vtexRequest(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const maxRetries = 5;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: options.method || "GET",
          headers: { ...this.headers, ...options.headers },
          body: options.body ? JSON.stringify(options.body) : undefined
        });

        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
          const backoffMs = retryAfter > 0
            ? retryAfter * 1000
            : Math.min(2000 * Math.pow(2, attempt), 60000);
          
          if (attempt < maxRetries) {
            console.log(`  [VTEX] Rate limited (429), waiting ${(backoffMs / 1000).toFixed(1)}s before retry ${attempt + 1}/${maxRetries}...`);
            await delay(backoffMs);
            continue;
          }
          throw new Error(`VTEX API error: 429 - Too Many Requests (exhausted ${maxRetries} retries)`);
        }

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`  [VTEX] Error ${response.status}: ${errorText}`);
          throw new Error(`VTEX API error: ${response.status} - ${errorText}`);
        }

        const json = await response.json();
        if (options.returnHeaders) {
          return { json, headers: Object.fromEntries(response.headers.entries()) };
        }
        return json;
      } catch (error) {
        if (error.message.includes('429') && attempt < maxRetries) continue;
        if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
          if (attempt < maxRetries) {
            const backoffMs = Math.min(2000 * Math.pow(2, attempt), 30000);
            console.log(`  [VTEX] Connection error (${error.code}), retrying in ${(backoffMs / 1000).toFixed(1)}s...`);
            await delay(backoffMs);
            continue;
          }
        }
        console.error(`  [VTEX] Request failed:`, error.message);
        throw error;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // AVAILABILITY CHECKING
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Check if a product is available for purchase
   * A product is available if ANY SKU has ANY seller with IsAvailable=true
   * 
   * @param {Object} product - Raw product from VTEX Search API
   * @returns {boolean} - true if product can be purchased
   */
  isProductAvailable(product) {
    return product.items?.some(sku => 
      sku.sellers?.some(seller => 
        seller.commertialOffer?.IsAvailable === true
      )
    ) || false;
  }

  /**
   * Get detailed availability info for a product
   * 
   * @param {Object} product - Raw product from VTEX Search API
   * @returns {Object} - Availability details
   */
  getProductAvailability(product) {
    let totalStock = 0;
    let isAvailable = false;
    let hasPrice = false;
    let minPrice = Infinity;
    
    for (const sku of (product.items || [])) {
      for (const seller of (sku.sellers || [])) {
        const offer = seller.commertialOffer || {};
        
        if (offer.IsAvailable) isAvailable = true;
        totalStock += (offer.AvailableQuantity || 0);
        
        if (offer.Price > 0) {
          hasPrice = true;
          minPrice = Math.min(minPrice, offer.Price);
        }
      }
    }
    
    return {
      isAvailable,
      totalStock,
      hasPrice,
      minPrice: minPrice === Infinity ? 0 : minPrice,
      shouldIndex: isAvailable && hasPrice
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // PRODUCT FETCHING - INCREMENTAL (Fetch IDs + Process in chunks)
  // ═══════════════════════════════════════════════════════════════════════════════
  
  /**
   * Fetch products with pagination - ONLY returns available products
   * 
   * STRATEGY: Fetch and process incrementally
   * 1. Fetch a batch of product IDs from Catalog API
   * 2. Immediately fetch details for those IDs
   * 3. Filter by availability
   * 4. Return and continue to next batch
   * 
   * Benefits:
   * - Low memory usage (no storing 16K IDs)
   * - Products indexed as we go
   * - Resilient to crashes
   */
  async fetchProducts(options = {}) {
    // Initialize cursor if first call
    if (this.catalogCursor === undefined) {
      try {
        const result = await this.vtexRequest('/api/catalog_system/pvt/products/GetProductAndSkuIds?_from=1&_to=1', { returnHeaders: true });
        const { json: countResponse, headers } = result;
        // Parse total from REST-Content-Range (format: "items 0-0/3500" or "0-0/3500")
        const rangeHeader = headers['rest-content-range'] || headers['content-range'] || '';
        const totalMatch = rangeHeader.match(/\/(\d+)\s*$/);
        this.totalProducts = totalMatch ? parseInt(totalMatch[1], 10) : (countResponse.range?.total || null);
        // range.total in body is the current batch size, NOT catalog total - never use it for pagination
        if (this.totalProducts && this.totalProducts > 1) {
          this.catalogCursor = Math.max(1, this.totalProducts - 249);
          this.fetchDirection = 'backwards';
          console.log(`  [VTEX] Starting from newest products (${this.totalProducts} total, starting at ${this.catalogCursor})`);
        } else {
          this.catalogCursor = 1;
          this.totalProducts = null; // Unknown total - fetch until empty
          this.fetchDirection = 'forwards';
          console.log("  [VTEX] Starting incremental fetch (total unknown, will fetch until no more products)...");
        }
      } catch (error) {
        this.catalogCursor = 1;
        this.totalProducts = null;
        this.fetchDirection = 'forwards';
        console.log("  [VTEX] Starting incremental fetch...");
      }
    }

    // If we've reached the end, return empty
    if (this.fetchDirection === 'backwards' && this.catalogCursor < 1) {
      return { products: [], nextCursor: null, hasNextPage: false };
    }
    if (this.fetchDirection === 'forwards' && this.totalProducts !== null && this.catalogCursor > this.totalProducts) {
      return { products: [], nextCursor: null, hasNextPage: false };
    }

    // Fetch ONE batch of product IDs from Catalog API (250 at a time)
    const from = this.catalogCursor;
    const to = Math.min(from + 249, this.totalProducts || from + 249);
    
    const idsEndpoint = `/api/catalog_system/pvt/products/GetProductAndSkuIds?_from=${from}&_to=${to}`;
    
    let productIds = [];
    try {
      const response = await this.vtexRequest(idsEndpoint);
      const data = response.data || response;
      // NOTE: range.total in the response body is the BATCH size, NOT the catalog total.
      // Never use it for pagination - it causes sync to stop after the first batch.

      // Extract product IDs
      productIds = Object.keys(data).filter(k => k !== 'range' && !isNaN(k));
      
      if (productIds.length === 0) {
        this.catalogCursor = (this.totalProducts || 0) + 1;
        return { products: [], nextCursor: null, hasNextPage: false };
      }

      // Update cursor for next call
      if (this.fetchDirection === 'backwards') {
        this.catalogCursor = from - 250; // Move backwards
      } else {
        this.catalogCursor = to + 1; // Move forwards
      }
      
    } catch (error) {
      console.error(`  [VTEX] Error fetching IDs:`, error.message);
      return { products: [], nextCursor: null, hasNextPage: false };
    }

    // Fetch details for this batch
    const progressStr = this.totalProducts ? `${((from / this.totalProducts) * 100).toFixed(1)}%` : '?';
    console.log(`  [VTEX] Fetching ${productIds.length} products (${from}-${to} of ${this.totalProducts ?? '?'}) - ${progressStr}`);
    
    const availableProducts = [];
    
    const BATCH_SIZE = 25;
    const BATCH_DELAY_MS = 300;

    for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
      const batchIds = productIds.slice(i, i + BATCH_SIZE);
      const fq = batchIds.map(id => `productId:${id}`).join(',');
      const endpoint = `/api/catalog_system/pub/products/search?fq=${encodeURIComponent(fq)}`;
      
      try {
        const products = await this.vtexRequest(endpoint);
        
        for (const product of products) {
          this.stats.totalFetched++;
          const availability = this.getProductAvailability(product);
          
          if (availability.shouldIndex) {
            availableProducts.push(product);
            this.stats.available++;
          } else {
            if (!availability.isAvailable) this.stats.outOfStock++;
            if (!availability.hasPrice) this.stats.noPrice++;
          }
        }
      } catch (error) {
        console.log(`  [VTEX] Detail fetch error: ${error.message}`);
      }
      
      await delay(BATCH_DELAY_MS);
    }

    const hasMore = this.fetchDirection === 'backwards' 
      ? this.catalogCursor >= 1 
      : (this.totalProducts === null || this.catalogCursor <= this.totalProducts);

    console.log(`  [VTEX] → ${availableProducts.length} available, ${productIds.length - availableProducts.length} skipped (total: ${this.stats.available} indexed, ${this.stats.outOfStock} out of stock)`);

    // Transform and return immediately for saving
    const transformedProducts = availableProducts.map(p => this.transformSearchProduct(p));

    return {
      products: transformedProducts,
      nextCursor: hasMore ? String(this.catalogCursor) : null,
      hasNextPage: hasMore
    };
  }

  /**
   * Log final availability stats
   */
  logFinalStats() {
    console.log("\n  ════════════════════════════════════════════════════════════");
    console.log("  [VTEX] AVAILABILITY STATS:");
    console.log(`    Total fetched from API:    ${this.stats.totalFetched}`);
    console.log(`    Available (indexed):       ${this.stats.available} (${((this.stats.available / this.stats.totalFetched) * 100).toFixed(1)}%)`);
    console.log(`    Out of stock (skipped):    ${this.stats.outOfStock}`);
    console.log(`    No price (skipped):        ${this.stats.noPrice}`);
    console.log("  ════════════════════════════════════════════════════════════\n");
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // COLLECTIONS & SHOP DATA
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Fetch all collections/categories from VTEX
   */
  async fetchCollections() {
    console.log("  [VTEX] Fetching categories...");
    
    try {
      // Fetch category tree (3 levels deep)
      const endpoint = "/api/catalog_system/pub/category/tree/3";
      const categories = await this.vtexRequest(endpoint);
      
      const collections = this.flattenCategories(categories);
      console.log(`  [VTEX] Found ${collections.length} categories`);
      
      return collections;
    } catch (error) {
      console.error("  [VTEX] Error fetching categories:", error.message);
      return [];
    }
  }

  /**
   * Flatten nested category tree
   */
  flattenCategories(categories, result = []) {
    for (const cat of categories) {
      result.push({
        id: String(cat.id),
        title: cat.name,
        handle: cat.url?.replace(/^\/|\/$/g, '') || cat.name.toLowerCase().replace(/\s+/g, '-')
      });
      
      if (cat.children && cat.children.length > 0) {
        this.flattenCategories(cat.children, result);
      }
    }
    return result;
  }

  /**
   * Get shop data (currency, name, etc.)
   */
  async getShopData() {
    // VTEX doesn't have a direct shop info endpoint
    // Try to detect currency from first available product, default to RON for Romanian stores
    return {
      currency: "RON", // Most VTEX stores we work with are Romanian
      name: this.accountName,
      domain: `${this.accountName}.vtexcommercestable.com.br`
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // PRODUCT TRANSFORMATION
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Transform product from Search API format
   * Only called for products that passed availability check
   */
  transformSearchProduct(product) {
    // Get availability info for price extraction
    const availability = this.getProductAvailability(product);
    
    // Find available items/SKUs only
    const availableItems = (product.items || []).filter(item =>
      item.sellers?.some(seller => seller.commertialOffer?.IsAvailable)
    );

    const mainItem = availableItems[0] || product.items?.[0] || {};
    
    // Get images from available item
    const images = mainItem.images?.map(img => ({ 
      src: img.imageUrl, 
      alt: img.imageText || img.imageLabel || "" 
    })) || [];

    // Transform only available variants
    const variants = availableItems.map(item => {
      // Find the seller with available stock
      const availableSeller = item.sellers?.find(s => s.commertialOffer?.IsAvailable) || item.sellers?.[0];
      const offer = availableSeller?.commertialOffer || {};
      
      return {
        id: String(item.itemId),
        title: item.name || item.nameComplete,
        price: offer.Price || offer.ListPrice || "0",
        compare_at_price: offer.ListPrice || offer.PriceWithoutDiscount,
        sku: item.referenceId?.[0]?.Value || item.ean || "",
        inventory_quantity: offer.AvailableQuantity || 0,
        isAvailable: offer.IsAvailable || false,
        ...this.extractItemVariations(item)
      };
    });

    // Extract product clusters as tags
    const tags = [];
    if (product.productClusters) {
      Object.values(product.productClusters).forEach(cluster => {
        if (typeof cluster === 'string') tags.push(cluster);
      });
    }
    if (product.clusterHighlights) {
      Object.values(product.clusterHighlights).forEach(highlight => {
        if (typeof highlight === 'string') tags.push(highlight);
      });
    }

    // Detect demographic from categories/product data
    const demographics = this.detectDemographic(product);

    return {
      id: String(product.productId),
      title: product.productName,
      body_html: product.description || product.metaTagDescription || "",
      descriptionHtml: product.description || "",
      handle: product.linkText,
      vendor: product.brand,
      product_type: this.extractCategoryName(product.categories),
      status: "active", // Only available products reach this point
      tags: tags.join(", "),
      published_at: product.releaseDate,
      images,
      image: images[0]?.src || null,
      variants,
      options: this.extractItemOptions(availableItems),
      collections: this.extractCollections(product.categories, product.categoriesIds),
      metafields: this.extractSearchMetafields(product),
      // Detected demographic (used by base provider for Neo4j)
      detectedDemographics: demographics,
      // VTEX-specific fields
      vtex: {
        productReference: product.productReference,
        brandId: product.brandId,
        categoryId: product.categoryId,
        link: product.link,
        totalStock: availability.totalStock,
        minPrice: availability.minPrice
      }
    };
  }

  /**
   * Extract category name from categories array
   */
  extractCategoryName(categories) {
    if (!categories || categories.length === 0) return "";
    // Get the last (most specific) category
    const lastCategory = categories[categories.length - 1];
    return lastCategory?.replace(/^\/|\/$/g, '').split('/').pop() || "";
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // DEMOGRAPHIC DETECTION
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Detect demographic (woman/man/unisex) from the first category path.
   * Matches top-level /femei/ → woman, /bărbați/ → man, otherwise unisex.
   * 
   * @param {Object} product - Raw VTEX product from Search API
   * @returns {string[]} - Array of demographics: ["woman"], ["man"], or ["unisex"]
   */
  detectDemographic(product) {
    const firstCategory = (product.categories || [])[0]?.toLowerCase() || '';
    const demographics = [];

    if (firstCategory.startsWith('/femei/')) demographics.push('woman');
    if (firstCategory.startsWith('/bărbați/')) demographics.push('man');
    if (demographics.length === 0) demographics.push('unisex');

    if (this.stats.totalFetched <= 5) {
      console.log(`  [VTEX] Demographic for "${product.productName?.substring(0, 30)}...": ${demographics.join(', ')} (from "${firstCategory}")`);
    }

    return demographics;
  }

  /**
   * Extract collections from categories
   */
  extractCollections(categories, categoryIds) {
    if (!categories) return [];
    
    return categories.map((cat, idx) => {
      const cleanPath = cat.replace(/^\/|\/$/g, '');
      const parts = cleanPath.split('/');
      return {
        id: categoryIds?.[idx] ? String(categoryIds[idx]) : `cat-${idx}`,
        title: parts[parts.length - 1], // Last part is the category name
        handle: cleanPath,
        fullPath: cleanPath
      };
    });
  }

  /**
   * Extract metafields from search product
   */
  extractSearchMetafields(product) {
    const metafields = [];
    
    // Add brand as metafield
    if (product.brand) {
      metafields.push({ key: "brand", value: product.brand, namespace: "vtex" });
    }
    
    // Add product specifications
    if (product.allSpecifications) {
      product.allSpecifications.forEach(specName => {
        const value = product[specName];
        if (value) {
          metafields.push({
            key: specName,
            value: Array.isArray(value) ? value.join(', ') : String(value),
            namespace: "vtex"
          });
        }
      });
    }
    
    return metafields;
  }

  /**
   * Extract variations from search item
   */
  extractItemVariations(item) {
    const variations = {};
    
    if (item.variations) {
      item.variations.forEach((variation, idx) => {
        const value = item[variation];
        variations[`option${idx + 1}`] = Array.isArray(value) ? value[0] : value;
      });
    }
    
    // Common VTEX variation fields (support both English and Portuguese)
    if (item.Color) variations.option1 = Array.isArray(item.Color) ? item.Color[0] : item.Color;
    if (item.Cor) variations.option1 = Array.isArray(item.Cor) ? item.Cor[0] : item.Cor;
    if (item.Size) variations.option2 = Array.isArray(item.Size) ? item.Size[0] : item.Size;
    if (item.Tamanho) variations.option2 = Array.isArray(item.Tamanho) ? item.Tamanho[0] : item.Tamanho;
    if (item.Marime) variations.option2 = Array.isArray(item.Marime) ? item.Marime[0] : item.Marime; // Romanian
    if (item.Culoare) variations.option1 = Array.isArray(item.Culoare) ? item.Culoare[0] : item.Culoare; // Romanian
    
    return variations;
  }

  /**
   * Extract options from search items
   */
  extractItemOptions(items) {
    const optionNames = new Set();
    
    items?.forEach(item => {
      if (item.variations) {
        item.variations.forEach(v => optionNames.add(v));
      }
    });
    
    return Array.from(optionNames).map((name, idx) => ({
      name,
      position: idx + 1
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // CURSOR STATE FOR RESUME
  // ═══════════════════════════════════════════════════════════════════════════════

  getCursorState() {
    return {
      catalogCursor: this.catalogCursor,
      fetchDirection: this.fetchDirection,
      totalProducts: this.totalProducts,
      stats: { ...this.stats }
    };
  }

  restoreCursorState(state) {
    if (!state) return;
    this.catalogCursor = state.catalogCursor;
    this.fetchDirection = state.fetchDirection;
    this.totalProducts = state.totalProducts;
    if (state.stats) this.stats = { ...state.stats };
    console.log(`  [VTEX] Restored cursor: position ${this.catalogCursor}, direction ${this.fetchDirection}, total ${this.totalProducts}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // OVERRIDE SYNC TO LOG FINAL STATS
  // ═══════════════════════════════════════════════════════════════════════════════

  async sync() {
    console.log(`\n=== Starting ${this.providerType} Sync for ${this.shopName} ===`);
    console.log(`  [VTEX] NOTE: Only AVAILABLE products will be indexed (in stock + valid price)\n`);
    
    await super.sync();
    
    // Log final availability stats
    this.logFinalStats();
  }
}

export default VtexProvider;
