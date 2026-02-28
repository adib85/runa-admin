# Platform Adapter Development Guide

This guide explains how to create adapters for new e-commerce platforms.

## Overview

Platform adapters provide a unified interface for connecting to different e-commerce platforms. Each adapter implements the same interface, allowing the sync pipeline to work with any platform without knowing the underlying API details.

## Adapter Interface

All adapters must extend the `BaseAdapter` class and implement the following interface:

```javascript
// packages/adapters/src/types.js

/**
 * @typedef {Object} Credentials
 * @property {string} [accessToken] - OAuth access token
 * @property {string} [refreshToken] - OAuth refresh token
 * @property {string} [apiKey] - API key for key-based auth
 * @property {string} [apiSecret] - API secret
 * @property {Date} [expiresAt] - Token expiration date
 */

/**
 * @typedef {Object} Product
 * @property {string} id - Unique product ID
 * @property {string} platformId - Platform-specific ID
 * @property {string} title - Product title
 * @property {string} handle - URL-friendly handle
 * @property {string} description - Product description (HTML)
 * @property {string} descriptionText - Plain text description
 * @property {string} vendor - Brand/vendor name
 * @property {string} productType - Product type/category
 * @property {number} price - Current price
 * @property {number|null} compareAtPrice - Original/compare price
 * @property {string} currency - Currency code (USD, EUR, etc.)
 * @property {string[]} images - Array of image URLs
 * @property {Variant[]} variants - Product variants
 * @property {string[]} tags - Product tags
 * @property {string} status - Product status (active, draft, archived)
 * @property {Date} createdAt - Creation timestamp
 * @property {Date} updatedAt - Last update timestamp
 */

/**
 * @typedef {Object} Variant
 * @property {string} id - Variant ID
 * @property {string} title - Variant title
 * @property {string} sku - SKU code
 * @property {number} price - Variant price
 * @property {number|null} compareAtPrice - Compare price
 * @property {number} inventory - Stock quantity
 * @property {string} barcode - Barcode/UPC
 * @property {Object} options - Variant options (size, color, etc.)
 */

/**
 * @typedef {Object} Category
 * @property {string} id - Category ID
 * @property {string} name - Category name
 * @property {string} slug - URL-friendly slug
 * @property {string|null} parentId - Parent category ID
 * @property {number} level - Nesting level (0 = root)
 * @property {number} productCount - Number of products
 */

/**
 * @typedef {Object} ProductPage
 * @property {Product[]} products - Array of products
 * @property {boolean} hasNextPage - Whether more pages exist
 * @property {string|null} cursor - Cursor for next page
 * @property {number} totalCount - Total products available
 */
```

## Base Adapter Class

```javascript
// packages/adapters/src/base.js

export class BaseAdapter {
  constructor(domain, credentials = {}) {
    this.domain = domain;
    this.credentials = credentials;
    this.platform = 'base';
  }

  // Must be implemented by subclasses
  async getProducts(cursor = null, limit = 50) {
    throw new Error('getProducts must be implemented');
  }

  async getProduct(id) {
    throw new Error('getProduct must be implemented');
  }

  async getProductsCount() {
    throw new Error('getProductsCount must be implemented');
  }

  async getCategories() {
    throw new Error('getCategories must be implemented');
  }

  // Optional methods with default implementations
  async testConnection() {
    try {
      await this.getProductsCount();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async registerWebhooks(callbackUrl) {
    console.warn(`Webhooks not supported for ${this.platform}`);
    return [];
  }

  handleWebhook(payload) {
    return { type: 'unknown', data: payload };
  }

  // Helper for normalizing products to unified schema
  normalizeProduct(platformProduct) {
    throw new Error('normalizeProduct must be implemented');
  }
}
```

## Creating a New Adapter

### Step 1: Create Adapter Directory

```bash
mkdir -p packages/adapters/src/myplatform
touch packages/adapters/src/myplatform/adapter.js
touch packages/adapters/src/myplatform/client.js  # Optional
```

### Step 2: Implement the Adapter

```javascript
// packages/adapters/src/myplatform/adapter.js

import { BaseAdapter } from '../base.js';

export class MyPlatformAdapter extends BaseAdapter {
  constructor(domain, credentials) {
    super(domain, credentials);
    this.platform = 'myplatform';
    this.baseUrl = `https://${domain}/api/v1`;
  }

  /**
   * Fetch products with pagination
   * @param {string|null} cursor - Pagination cursor
   * @param {number} limit - Products per page
   * @returns {Promise<ProductPage>}
   */
  async getProducts(cursor = null, limit = 50) {
    const params = new URLSearchParams({
      limit: limit.toString(),
      ...(cursor && { page: cursor })
    });

    const response = await fetch(`${this.baseUrl}/products?${params}`, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();

    return {
      products: data.products.map(p => this.normalizeProduct(p)),
      hasNextPage: data.hasMore,
      cursor: data.nextPage,
      totalCount: data.total
    };
  }

  /**
   * Fetch a single product by ID
   * @param {string} id - Product ID
   * @returns {Promise<Product>}
   */
  async getProduct(id) {
    const response = await fetch(`${this.baseUrl}/products/${id}`, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Product not found: ${id}`);
    }

    const data = await response.json();
    return this.normalizeProduct(data.product);
  }

  /**
   * Get total product count
   * @returns {Promise<number>}
   */
  async getProductsCount() {
    const response = await fetch(`${this.baseUrl}/products/count`, {
      headers: this.getHeaders()
    });

    const data = await response.json();
    return data.count;
  }

  /**
   * Get all categories
   * @returns {Promise<Category[]>}
   */
  async getCategories() {
    const response = await fetch(`${this.baseUrl}/categories`, {
      headers: this.getHeaders()
    });

    const data = await response.json();
    return data.categories.map(c => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      parentId: c.parent_id || null,
      level: c.depth || 0,
      productCount: c.products_count || 0
    }));
  }

  /**
   * Register webhooks for real-time updates
   * @param {string} callbackUrl - URL to receive webhooks
   * @returns {Promise<string[]>} - Registered webhook IDs
   */
  async registerWebhooks(callbackUrl) {
    const topics = ['products/created', 'products/updated', 'products/deleted'];
    const webhookIds = [];

    for (const topic of topics) {
      const response = await fetch(`${this.baseUrl}/webhooks`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          topic,
          address: `${callbackUrl}/webhooks/myplatform`,
          format: 'json'
        })
      });

      const data = await response.json();
      webhookIds.push(data.webhook.id);
    }

    return webhookIds;
  }

  /**
   * Parse incoming webhook payload
   * @param {Object} payload - Raw webhook payload
   * @returns {Object} - Normalized webhook event
   */
  handleWebhook(payload) {
    const { topic, data } = payload;

    return {
      type: topic.replace('products/', 'product_'),
      productId: data.id,
      product: topic !== 'products/deleted' ? this.normalizeProduct(data) : null
    };
  }

  /**
   * Normalize platform product to unified schema
   * @param {Object} p - Platform-specific product
   * @returns {Product}
   */
  normalizeProduct(p) {
    return {
      id: `myplatform-${p.id}`,
      platformId: p.id.toString(),
      title: p.name || p.title,
      handle: p.slug || this.slugify(p.name),
      description: p.description_html || p.description || '',
      descriptionText: this.stripHtml(p.description_html || p.description || ''),
      vendor: p.brand || p.vendor || '',
      productType: p.category || p.type || '',
      price: parseFloat(p.price) || 0,
      compareAtPrice: p.compare_price ? parseFloat(p.compare_price) : null,
      currency: p.currency || 'USD',
      images: this.extractImages(p),
      variants: this.normalizeVariants(p.variants || []),
      tags: p.tags || [],
      status: this.mapStatus(p.status),
      createdAt: new Date(p.created_at),
      updatedAt: new Date(p.updated_at)
    };
  }

  // Private helper methods

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.credentials.accessToken}`
    };
  }

  normalizeVariants(variants) {
    return variants.map(v => ({
      id: v.id.toString(),
      title: v.title || v.name,
      sku: v.sku || '',
      price: parseFloat(v.price) || 0,
      compareAtPrice: v.compare_price ? parseFloat(v.compare_price) : null,
      inventory: v.inventory_quantity || 0,
      barcode: v.barcode || '',
      options: v.options || {}
    }));
  }

  extractImages(product) {
    if (product.images && Array.isArray(product.images)) {
      return product.images.map(img =>
        typeof img === 'string' ? img : img.src || img.url
      );
    }
    if (product.image) {
      return [typeof product.image === 'string' ? product.image : product.image.src];
    }
    return [];
  }

  mapStatus(platformStatus) {
    const statusMap = {
      'published': 'active',
      'active': 'active',
      'draft': 'draft',
      'unpublished': 'draft',
      'archived': 'archived',
      'deleted': 'archived'
    };
    return statusMap[platformStatus?.toLowerCase()] || 'draft';
  }

  slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }

  stripHtml(html) {
    return html.replace(/<[^>]*>/g, '').trim();
  }
}
```

### Step 3: Export the Adapter

```javascript
// packages/adapters/src/myplatform/index.js
export { MyPlatformAdapter } from './adapter.js';
```

```javascript
// packages/adapters/index.js
export { ShopifyAdapter } from './src/shopify/adapter.js';
export { WooCommerceAdapter } from './src/woocommerce/adapter.js';
export { VTEXAdapter } from './src/vtex/adapter.js';
export { MyPlatformAdapter } from './src/myplatform/adapter.js';  // Add this
```

### Step 4: Register in the Factory

```javascript
// packages/adapters/src/factory.js

import { ShopifyAdapter } from './shopify/adapter.js';
import { WooCommerceAdapter } from './woocommerce/adapter.js';
import { VTEXAdapter } from './vtex/adapter.js';
import { MyPlatformAdapter } from './myplatform/adapter.js';

const adapters = {
  shopify: ShopifyAdapter,
  woocommerce: WooCommerceAdapter,
  vtex: VTEXAdapter,
  myplatform: MyPlatformAdapter  // Add this
};

export function createAdapter(platform, domain, credentials) {
  const AdapterClass = adapters[platform.toLowerCase()];

  if (!AdapterClass) {
    throw new Error(`Unknown platform: ${platform}`);
  }

  return new AdapterClass(domain, credentials);
}

export function getSupportedPlatforms() {
  return Object.keys(adapters);
}
```

## Testing Your Adapter

### Unit Tests

```javascript
// packages/adapters/src/myplatform/adapter.test.js

import { describe, it, expect, vi } from 'vitest';
import { MyPlatformAdapter } from './adapter.js';

describe('MyPlatformAdapter', () => {
  const adapter = new MyPlatformAdapter('test-store.com', {
    accessToken: 'test-token'
  });

  describe('normalizeProduct', () => {
    it('should normalize platform product to unified schema', () => {
      const platformProduct = {
        id: '123',
        name: 'Test Product',
        description_html: '<p>Description</p>',
        price: '29.99',
        status: 'published',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-15T00:00:00Z'
      };

      const normalized = adapter.normalizeProduct(platformProduct);

      expect(normalized.id).toBe('myplatform-123');
      expect(normalized.title).toBe('Test Product');
      expect(normalized.price).toBe(29.99);
      expect(normalized.status).toBe('active');
    });
  });

  describe('getProducts', () => {
    it('should fetch and normalize products', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          products: [{ id: '1', name: 'Product 1', price: '10' }],
          hasMore: false,
          total: 1
        })
      });

      const result = await adapter.getProducts();

      expect(result.products).toHaveLength(1);
      expect(result.products[0].title).toBe('Product 1');
      expect(result.hasNextPage).toBe(false);
    });
  });
});
```

### Integration Tests

```javascript
// packages/adapters/src/myplatform/adapter.integration.test.js

import { describe, it, expect } from 'vitest';
import { MyPlatformAdapter } from './adapter.js';

// Skip in CI, run manually with real credentials
describe.skip('MyPlatformAdapter Integration', () => {
  const adapter = new MyPlatformAdapter(
    process.env.TEST_STORE_DOMAIN,
    { accessToken: process.env.TEST_ACCESS_TOKEN }
  );

  it('should connect to the store', async () => {
    const result = await adapter.testConnection();
    expect(result.success).toBe(true);
  });

  it('should fetch products', async () => {
    const { products, totalCount } = await adapter.getProducts(null, 10);
    expect(products.length).toBeGreaterThan(0);
    expect(products[0]).toHaveProperty('id');
    expect(products[0]).toHaveProperty('title');
  });
});
```

## Best Practices

### 1. Error Handling

Always provide meaningful error messages:

```javascript
async getProducts(cursor, limit) {
  try {
    const response = await fetch(url, { headers: this.getHeaders() });

    if (response.status === 401) {
      throw new Error('Authentication failed. Please reconnect your store.');
    }

    if (response.status === 429) {
      throw new Error('Rate limit exceeded. Please try again later.');
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || `API error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    if (error.name === 'TypeError') {
      throw new Error('Network error. Please check your connection.');
    }
    throw error;
  }
}
```

### 2. Rate Limiting

Implement rate limiting to avoid API throttling:

```javascript
class RateLimiter {
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = [];
  }

  async acquire() {
    const now = Date.now();
    this.requests = this.requests.filter(t => t > now - this.windowMs);

    if (this.requests.length >= this.maxRequests) {
      const waitTime = this.requests[0] - (now - this.windowMs);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return this.acquire();
    }

    this.requests.push(now);
  }
}

// Usage in adapter
this.rateLimiter = new RateLimiter(40, 1000); // 40 requests per second

async getProducts(cursor, limit) {
  await this.rateLimiter.acquire();
  // ... make request
}
```

### 3. Caching

Cache frequently accessed data:

```javascript
const cache = new Map();

async getCategories() {
  const cacheKey = `${this.domain}:categories`;

  if (cache.has(cacheKey)) {
    const { data, expires } = cache.get(cacheKey);
    if (expires > Date.now()) {
      return data;
    }
  }

  const categories = await this.fetchCategories();

  cache.set(cacheKey, {
    data: categories,
    expires: Date.now() + 5 * 60 * 1000 // 5 minutes
  });

  return categories;
}
```

### 4. Pagination

Handle large catalogs efficiently:

```javascript
async *getAllProducts(batchSize = 50) {
  let cursor = null;
  let hasMore = true;

  while (hasMore) {
    const { products, hasNextPage, cursor: nextCursor } =
      await this.getProducts(cursor, batchSize);

    for (const product of products) {
      yield product;
    }

    hasMore = hasNextPage;
    cursor = nextCursor;
  }
}

// Usage
for await (const product of adapter.getAllProducts()) {
  await processProduct(product);
}
```

## Existing Adapter Examples

### Shopify (GraphQL)

See `packages/adapters/src/shopify/` for a GraphQL-based adapter with:
- Cursor-based pagination
- Bulk operations support
- Webhook management

### WooCommerce (REST)

See `packages/adapters/src/woocommerce/` for a REST API adapter with:
- OAuth 1.0a authentication
- Pagination via page numbers
- Variation handling

### VTEX

See `packages/adapters/src/vtex/` for the VTEX adapter with:
- Catalog API integration
- Search API support
- SKU-based products
