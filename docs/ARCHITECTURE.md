# Architecture Overview

## System Design

Runa Admin follows a monorepo architecture with clear separation of concerns between the frontend, API, and core business logic.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ADMIN DASHBOARD (Web App)                        │
│  - Onboarding wizard                                                     │
│  - Store management                                                      │
│  - Product catalog viewer                                                │
│  - Analytics & sync status                                               │
│  - Settings & configuration                                              │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           API LAYER (REST)                               │
│  /api/auth          - JWT authentication & user management               │
│  /api/stores        - CRUD for connected stores                          │
│  /api/products      - Product management & search                        │
│  /api/sync          - Trigger/monitor sync jobs                          │
│  /api/settings      - Store configuration                                │
│  /api/webhooks      - Receive platform webhooks                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        PLATFORM ADAPTERS                                 │
├─────────────────┬─────────────────┬─────────────────┬───────────────────┤
│    Shopify      │    WooCommerce  │     VTEX        │    Custom/API     │
│    Adapter      │    Adapter      │     Adapter     │    Adapter        │
├─────────────────┴─────────────────┴─────────────────┴───────────────────┤
│  Unified Interface:                                                      │
│  - authenticate()      - getProducts(pagination)                         │
│  - getCategories()     - syncProduct(product)                            │
│  - registerWebhooks()  - handleWebhook(payload)                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      PROCESSING PIPELINE                                 │
│  ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐     │
│  │  Fetch     │ → │  Transform │ → │  Enrich    │ → │  Store     │     │
│  │  Products  │   │  & Normalize│   │  with AI   │   │  in DB     │     │
│  └────────────┘   └────────────┘   └────────────┘   └────────────┘     │
│                                                                          │
│  - Real-time progress via PubNub                                         │
│  - Retry & error handling                                                │
│  - Cost tracking for AI operations                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         DATA LAYER                                       │
├───────────────────────────┬───────────────────────┬─────────────────────┤
│        DynamoDB           │        Neo4j          │         S3          │
├───────────────────────────┼───────────────────────┼─────────────────────┤
│  - Users                  │  - Product nodes      │  - product-images/  │
│  - Stores                 │  - Category nodes     │  - exports/         │
│  - SyncJobs               │  - Relationships      │  - imports/         │
│  - Cache                  │  - Embeddings         │                     │
│  - Logs                   │                       │                     │
└───────────────────────────┴───────────────────────┴─────────────────────┘
```

## Package Structure

### `@runa/web` - Admin Dashboard

React single-page application built with Vite.

```
apps/web/
├── src/
│   ├── components/
│   │   └── Layout.jsx          # Main layout with navigation
│   ├── context/
│   │   └── AuthContext.jsx     # Authentication state management
│   ├── pages/
│   │   ├── Login.jsx           # Login page
│   │   ├── Register.jsx        # Registration with store setup
│   │   ├── Dashboard.jsx       # Overview dashboard
│   │   ├── Stores.jsx          # Store management
│   │   ├── StoreDetail.jsx     # Individual store view
│   │   ├── Products.jsx        # Product catalog
│   │   └── Settings.jsx        # User settings
│   ├── services/
│   │   └── api.js              # API client with auth
│   ├── App.jsx                 # Route definitions
│   └── main.jsx                # Entry point
├── tailwind.config.js          # Tailwind CSS configuration
└── vite.config.js              # Vite build configuration
```

### `@runa/api` - REST API Server

Express.js API server handling authentication and business operations.

```
apps/api/
└── src/
    ├── routes/
    │   ├── auth.js             # Authentication routes
    │   ├── stores.js           # Store management
    │   ├── products.js         # Product operations
    │   └── sync.js             # Sync job management
    ├── middleware/
    │   ├── auth.js             # JWT authentication
    │   └── error.js            # Error handling
    └── index.js                # Server entry point
```

### `@runa/adapters` - Platform Adapters

E-commerce platform connectors with unified interface.

```
packages/adapters/
├── src/
│   ├── shopify/
│   │   ├── client.js           # Shopify GraphQL client
│   │   ├── queries.js          # GraphQL queries
│   │   └── adapter.js          # Shopify adapter implementation
│   ├── woocommerce/
│   │   └── adapter.js          # WooCommerce REST adapter
│   ├── vtex/
│   │   └── adapter.js          # VTEX adapter
│   ├── base.js                 # Base adapter class
│   └── types.js                # TypeScript-like interfaces
└── index.js                    # Barrel exports
```

### `@runa/core` - Core Business Logic

Shared business logic, database operations, and services.

```
packages/core/
├── database/
│   ├── dynamodb/
│   │   ├── client.js           # DynamoDB client
│   │   ├── users.js            # User operations
│   │   ├── cache.js            # Caching layer
│   │   └── logs.js             # Sync logs
│   └── neo4j/
│       ├── client.js           # Neo4j driver
│       ├── products.js         # Product graph operations
│       └── categories.js       # Category management
├── services/
│   ├── ai/
│   │   ├── openai.js           # OpenAI integration
│   │   ├── gemini.js           # Google Gemini integration
│   │   ├── embeddings.js       # Vector embeddings
│   │   └── cost-tracker.js     # AI cost tracking
│   ├── storage/
│   │   └── s3.js               # S3 file operations
│   └── realtime/
│       └── pubnub.js           # Real-time broadcasting
├── sync/
│   └── pipeline.js             # Sync pipeline orchestration
└── utils/
    └── index.js                # Utility functions
```

## Data Flow

### 1. User Registration Flow

```
User Sign Up → Create Account → Connect Store → Initial Sync → Configure
     │              │                │               │              │
     ▼              ▼                ▼               ▼              ▼
  Validate      Save user       Store OAuth     Queue full     Set defaults:
  input         to DynamoDB     credentials     product sync   - AI enrichment
                                                Show progress  - Categories
```

### 2. Product Sync Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Trigger    │────▶│   Fetch     │────▶│  Transform  │────▶│   Enrich    │
│  Sync       │     │  Products   │     │  Products   │     │  with AI    │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                           │                   │                   │
                           ▼                   ▼                   ▼
                    Platform API        Normalize to         OpenAI/Gemini
                    (GraphQL/REST)      unified schema       classification
                           │                   │                   │
                           └───────────────────┴───────────────────┘
                                              │
                                              ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Broadcast  │◀────│   Store     │◀────│   Upload    │
│  Progress   │     │  in Neo4j   │     │  Images     │
└─────────────┘     └─────────────┘     └─────────────┘
      │
      ▼
   PubNub
   (real-time)
```

### 3. Real-Time Updates

```
┌─────────────────────────────────────────────────────────────────┐
│                        SYNC PIPELINE                             │
│                              │                                   │
│    progress: 45/100 ─────────┼──────────────────────────────────┤
│                              ▼                                   │
│                     ┌────────────────┐                          │
│                     │  PubNub        │                          │
│                     │  SyncBroadcaster│                          │
│                     └────────────────┘                          │
│                              │                                   │
└──────────────────────────────┼──────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
    ┌──────────┐        ┌──────────┐        ┌──────────┐
    │ Browser  │        │ Browser  │        │ Mobile   │
    │ Client 1 │        │ Client 2 │        │ App      │
    └──────────┘        └──────────┘        └──────────┘
```

## Database Schema

### DynamoDB Tables

**Users Table**
```
PK: userId (UUID)
├── email: string
├── name: string
├── password: string (hashed)
├── role: "user" | "admin"
├── stores: Store[]
├── createdAt: ISO date
└── updatedAt: ISO date
```

**SyncJobs Table**
```
PK: storeId
SK: timestamp
├── status: "pending" | "running" | "completed" | "failed"
├── progress: number
├── totalProducts: number
├── processedProducts: number
├── errors: Error[]
├── startedAt: ISO date
└── completedAt: ISO date
```

**Cache Table**
```
PK: cacheKey
├── value: any
├── ttl: number
└── createdAt: ISO date
```

### Neo4j Graph Schema

```
(:Product {
  id: string,
  platformId: string,
  title: string,
  handle: string,
  description: string,
  vendor: string,
  productType: string,
  price: float,
  compareAtPrice: float,
  currency: string,
  images: string[],
  status: string,
  createdAt: datetime,
  updatedAt: datetime,
  embedding: float[]  // Vector for similarity search
})

(:Category {
  id: string,
  name: string,
  slug: string,
  level: int
})

(:Store {
  id: string,
  domain: string,
  platform: string
})

// Relationships
(:Product)-[:BELONGS_TO]->(:Category)
(:Product)-[:SOLD_BY]->(:Store)
(:Product)-[:SIMILAR_TO]->(:Product)
(:Category)-[:CHILD_OF]->(:Category)
```

## Security

### Authentication

- JWT-based authentication with configurable expiration
- Password hashing using bcrypt (10 rounds)
- Token refresh mechanism for session extension

### API Security

- CORS configuration for allowed origins
- Request rate limiting (planned)
- Input validation on all endpoints
- SQL/NoSQL injection prevention

### Credential Storage

- OAuth tokens encrypted at rest
- Environment variables for sensitive configuration
- No credentials in source code or logs

## Scalability Considerations

### Current Architecture

- Monolithic API suitable for moderate traffic
- DynamoDB for horizontal scaling of user data
- Neo4j for complex product relationships
- S3 for unlimited image storage

### Future Improvements

1. **Queue-Based Processing** - Add SQS/BullMQ for async sync jobs
2. **Caching Layer** - Redis for API response caching
3. **CDN Integration** - CloudFront for static assets and images
4. **Microservices** - Split sync, AI, and API into separate services
5. **Auto-Scaling** - ECS/EKS for container orchestration

## Technology Choices

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Frontend | React + Vite | Fast development, excellent DX |
| Styling | Tailwind CSS | Utility-first, consistent design |
| API | Express.js | Mature, flexible, extensive middleware |
| Auth | JWT | Stateless, scalable authentication |
| User DB | DynamoDB | Serverless, auto-scaling, low latency |
| Graph DB | Neo4j | Native graph for product relationships |
| Storage | S3 | Unlimited, cost-effective file storage |
| AI | OpenAI/Gemini | Best-in-class language models |
| Real-time | PubNub | Managed WebSocket infrastructure |
