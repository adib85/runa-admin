# API Reference

Base URL: `http://localhost:3001/api`

## Authentication

All protected endpoints require a JWT token in the Authorization header:

```
Authorization: Bearer <token>
```

---

## Auth Endpoints

### POST /api/auth/register

Register a new user account with an initial store.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "securePassword123",
  "name": "John Doe",
  "storeUrl": "mystore.myshopify.com",
  "platform": "shopify"
}
```

**Response (201):**
```json
{
  "message": "User created successfully",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "name": "John Doe",
    "role": "user",
    "stores": [
      {
        "id": "store-uuid",
        "platform": "shopify",
        "domain": "mystore.myshopify.com",
        "name": "mystore",
        "status": "pending",
        "productsCount": 0,
        "lastSync": null,
        "createdAt": "2024-01-15T10:30:00.000Z"
      }
    ]
  }
}
```

**Errors:**
- `400` - Email and password are required
- `400` - Store URL and platform are required
- `409` - User already exists

---

### POST /api/auth/login

Authenticate a user and receive a JWT token.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "securePassword123"
}
```

**Response (200):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "name": "John Doe",
    "role": "user",
    "stores": [...]
  }
}
```

**Errors:**
- `400` - Email and password are required
- `401` - Invalid credentials

---

### GET /api/auth/me

Get the current authenticated user's profile.

**Headers:**
```
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "name": "John Doe",
  "role": "user",
  "stores": [...]
}
```

**Errors:**
- `401` - Unauthorized (invalid or missing token)
- `404` - User not found

---

### POST /api/auth/refresh

Refresh the JWT token.

**Headers:**
```
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

## Store Endpoints

### GET /api/stores

Get all stores for the authenticated user.

**Headers:**
```
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "stores": [
    {
      "id": "store-uuid-1",
      "platform": "shopify",
      "domain": "store1.myshopify.com",
      "name": "Store One",
      "status": "active",
      "productsCount": 150,
      "lastSync": "2024-01-15T10:30:00.000Z",
      "createdAt": "2024-01-01T00:00:00.000Z"
    },
    {
      "id": "store-uuid-2",
      "platform": "woocommerce",
      "domain": "store2.com",
      "name": "Store Two",
      "status": "pending",
      "productsCount": 0,
      "lastSync": null,
      "createdAt": "2024-01-10T00:00:00.000Z"
    }
  ]
}
```

---

### GET /api/stores/:id

Get a specific store by ID.

**Headers:**
```
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "store": {
    "id": "store-uuid",
    "platform": "shopify",
    "domain": "mystore.myshopify.com",
    "name": "My Store",
    "status": "active",
    "productsCount": 150,
    "lastSync": "2024-01-15T10:30:00.000Z",
    "credentials": {
      "accessToken": "***hidden***"
    },
    "settings": {
      "aiEnrichment": true,
      "syncFrequency": "daily"
    },
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

**Errors:**
- `404` - Store not found

---

### POST /api/stores

Add a new store to the user's account.

**Headers:**
```
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "platform": "shopify",
  "domain": "newstore.myshopify.com",
  "name": "New Store",
  "credentials": {
    "accessToken": "shpat_xxxxxxxxxxxxx"
  }
}
```

**Response (201):**
```json
{
  "message": "Store added successfully",
  "store": {
    "id": "new-store-uuid",
    "platform": "shopify",
    "domain": "newstore.myshopify.com",
    "name": "New Store",
    "status": "pending",
    "productsCount": 0,
    "createdAt": "2024-01-15T10:30:00.000Z"
  }
}
```

---

### PUT /api/stores/:id

Update a store's settings.

**Headers:**
```
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "name": "Updated Store Name",
  "settings": {
    "aiEnrichment": true,
    "syncFrequency": "hourly"
  }
}
```

**Response (200):**
```json
{
  "message": "Store updated successfully",
  "store": {...}
}
```

---

### DELETE /api/stores/:id

Remove a store from the user's account.

**Headers:**
```
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "message": "Store removed successfully"
}
```

---

## Product Endpoints

### GET /api/products

Get products across all stores or for a specific store.

**Headers:**
```
Authorization: Bearer <token>
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| storeId | string | Filter by store ID |
| category | string | Filter by category |
| search | string | Search in title/description |
| status | string | Filter by status (active, draft, archived) |
| page | number | Page number (default: 1) |
| limit | number | Items per page (default: 20, max: 100) |

**Response (200):**
```json
{
  "products": [
    {
      "id": "product-uuid",
      "platformId": "gid://shopify/Product/123456",
      "storeId": "store-uuid",
      "title": "Classic T-Shirt",
      "handle": "classic-t-shirt",
      "description": "A comfortable cotton t-shirt",
      "vendor": "Brand Name",
      "productType": "T-Shirts",
      "price": 29.99,
      "compareAtPrice": 39.99,
      "currency": "USD",
      "images": [
        "https://cdn.example.com/image1.jpg"
      ],
      "variants": [
        {
          "id": "variant-uuid",
          "title": "Small / Blue",
          "price": 29.99,
          "sku": "TS-001-S-BLU",
          "inventory": 50
        }
      ],
      "status": "active",
      "enrichedData": {
        "aiCategory": "Apparel > T-Shirts",
        "tags": ["casual", "cotton", "basics"],
        "styleAttributes": {
          "fit": "regular",
          "neckline": "crew"
        }
      },
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-15T10:30:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

---

### GET /api/products/:id

Get a specific product by ID.

**Headers:**
```
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "product": {
    "id": "product-uuid",
    ...
  }
}
```

---

## Sync Endpoints

### POST /api/sync/start

Start a sync job for a store.

**Headers:**
```
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "storeId": "store-uuid",
  "options": {
    "fullSync": false,
    "generateEmbeddings": true,
    "classifyProducts": true
  }
}
```

**Response (202):**
```json
{
  "message": "Sync started",
  "jobId": "sync-job-uuid",
  "channel": "sync-store-uuid"
}
```

The `channel` can be used to subscribe to real-time progress updates via PubNub.

---

### GET /api/sync/status/:storeId

Get the current sync status for a store.

**Headers:**
```
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "status": "running",
  "progress": 45,
  "totalProducts": 150,
  "processedProducts": 67,
  "startedAt": "2024-01-15T10:30:00.000Z",
  "estimatedCompletion": "2024-01-15T10:45:00.000Z"
}
```

---

### GET /api/sync/history/:storeId

Get sync history for a store.

**Headers:**
```
Authorization: Bearer <token>
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| limit | number | Number of records (default: 10) |

**Response (200):**
```json
{
  "history": [
    {
      "jobId": "sync-job-uuid",
      "status": "completed",
      "totalProducts": 150,
      "processedProducts": 150,
      "errors": [],
      "startedAt": "2024-01-15T10:30:00.000Z",
      "completedAt": "2024-01-15T10:45:00.000Z",
      "duration": 900000
    }
  ]
}
```

---

### POST /api/sync/cancel/:jobId

Cancel a running sync job.

**Headers:**
```
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "message": "Sync cancelled",
  "jobId": "sync-job-uuid"
}
```

---

## Webhook Endpoints

### POST /api/webhooks/:platform/:storeId

Receive webhooks from e-commerce platforms.

**Shopify Topics:**
- `products/create`
- `products/update`
- `products/delete`
- `collections/create`
- `collections/update`

**Request Body:** Platform-specific webhook payload

**Response (200):**
```json
{
  "received": true
}
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": {
    "message": "Human-readable error message",
    "code": "ERROR_CODE",
    "status": 400
  }
}
```

### Common Error Codes

| Status | Code | Description |
|--------|------|-------------|
| 400 | BAD_REQUEST | Invalid request parameters |
| 401 | UNAUTHORIZED | Missing or invalid authentication |
| 403 | FORBIDDEN | Insufficient permissions |
| 404 | NOT_FOUND | Resource not found |
| 409 | CONFLICT | Resource already exists |
| 429 | RATE_LIMITED | Too many requests |
| 500 | INTERNAL_ERROR | Server error |

---

## Rate Limiting

API requests are rate limited to:
- **100 requests per minute** for authenticated users
- **10 requests per minute** for unauthenticated endpoints

Rate limit headers are included in responses:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1705312800
```

---

## Real-Time Updates (PubNub)

Subscribe to sync progress updates:

**Channel Format:** `sync-{storeId}`

**Message Format:**
```json
{
  "type": "progress",
  "data": {
    "jobId": "sync-job-uuid",
    "progress": 45,
    "processed": 67,
    "total": 150,
    "currentProduct": "Classic T-Shirt"
  }
}
```

**Message Types:**
- `progress` - Sync progress update
- `complete` - Sync completed
- `error` - Sync error occurred
- `product` - Individual product synced
