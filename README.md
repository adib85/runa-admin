# Runa Admin

**Unified E-Commerce Admin Platform for [Runa AI](https://www.askruna.ai/)**

Runa is an AI-powered merchant platform for fashion retail that helps stores increase sales through intelligent product recommendations, visual merchandising, and automated trend analysis.

## Overview

Runa Admin is a multi-tenant platform that connects e-commerce stores from various platforms (Shopify, WooCommerce, VTEX, custom APIs) and provides:

- **AI-Powered Visual Merchandising** - Intelligent product categorization and display optimization
- **Personal Stylist Engine** - Automated outfit recommendations and product bundling
- **Trend Analysis** - Real-time fashion trend detection and inventory insights
- **Unified Product Catalog** - Centralized view of products across all connected stores

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ADMIN DASHBOARD (React)                          │
│  - Store management       - Product catalog viewer                       │
│  - Analytics & sync       - Settings & configuration                     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           API LAYER (Express)                            │
│  /api/auth     - Authentication & user management                        │
│  /api/stores   - CRUD for connected stores                               │
│  /api/products - Product management & search                             │
│  /api/sync     - Trigger/monitor sync jobs                               │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        PLATFORM ADAPTERS                                 │
├─────────────────┬─────────────────┬─────────────────┬───────────────────┤
│    Shopify      │   WooCommerce   │      VTEX       │    Custom API     │
└─────────────────┴─────────────────┴─────────────────┴───────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      PROCESSING PIPELINE                                 │
│  Fetch → Transform → AI Enrich → Store                                   │
│  - Real-time progress via PubNub                                         │
│  - Retry & error handling                                                │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────┬─────────────────────────────────────────────┐
│        DynamoDB           │              Neo4j + S3                       │
│  - Users & Auth           │  - Product Graph                             │
│  - Stores & Settings      │  - Images & Assets                           │
│  - Sync Jobs & Logs       │  - Embeddings                                │
└───────────────────────────┴─────────────────────────────────────────────┘
```

## Project Structure

```
runa-admin/
├── apps/
│   ├── web/                    # React admin dashboard (Vite)
│   │   ├── src/
│   │   │   ├── components/     # Reusable UI components
│   │   │   ├── context/        # React context (Auth)
│   │   │   ├── pages/          # Page components
│   │   │   └── services/       # API client
│   │   └── index.html
│   │
│   └── api/                    # Express API server
│       └── src/
│           ├── routes/         # API route handlers
│           └── middleware/     # Auth, error handling
│
├── packages/
│   ├── adapters/               # E-commerce platform adapters
│   │   ├── src/
│   │   │   ├── shopify/        # Shopify GraphQL adapter
│   │   │   ├── woocommerce/    # WooCommerce REST adapter
│   │   │   ├── vtex/           # VTEX adapter
│   │   │   └── types.js        # Shared interfaces
│   │   └── index.js
│   │
│   └── core/                   # Core business logic
│       ├── database/
│       │   ├── dynamodb/       # DynamoDB operations
│       │   └── neo4j/          # Neo4j graph operations
│       ├── services/
│       │   ├── ai/             # OpenAI/Gemini integration
│       │   ├── storage/        # S3 operations
│       │   └── realtime/       # PubNub broadcasting
│       ├── sync/               # Sync pipeline
│       └── utils/
│
└── docs/                       # Documentation
```

## Quick Start

### Prerequisites

- Node.js 18+
- npm 9+
- AWS credentials configured
- Neo4j database (local or Aura)

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd runa-admin

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your credentials
```

### Environment Variables

Create a `.env` file in the root directory:

```env
# AWS
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=us-east-1

# Neo4j
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your_password

# OpenAI (for AI enrichment)
OPENAI_API_KEY=your_openai_key

# PubNub (for real-time updates)
PUBNUB_PUBLISH_KEY=your_publish_key
PUBNUB_SUBSCRIBE_KEY=your_subscribe_key

# JWT
JWT_SECRET=your_jwt_secret

# API
PORT=3001
```

### Development

```bash
# Start both API and web app in development mode
npm run dev

# Or start individually:
npm run dev -w @runa/api    # API on http://localhost:3001
npm run dev -w @runa/web    # Web on http://localhost:5173
```

### Build

```bash
# Build all packages
npm run build
```

## Key Features

### Multi-Platform Support

Connect stores from multiple e-commerce platforms through a unified adapter interface:

| Platform    | Status      | Features                          |
|-------------|-------------|-----------------------------------|
| Shopify     | ✅ Ready    | Full sync, webhooks, GraphQL      |
| WooCommerce | ✅ Ready    | REST API, product sync            |
| VTEX        | ✅ Ready    | Catalog API, search integration   |
| Custom API  | 🔧 Flexible | Configurable endpoints            |

### AI-Powered Enrichment

- **Product Classification** - Automatic categorization using AI
- **Description Enhancement** - SEO-optimized product descriptions
- **Visual Analysis** - Image-based style detection
- **Trend Matching** - Connect products to current fashion trends

### Real-Time Sync

- Progress tracking via PubNub
- Webhook support for instant updates
- Batch processing with retry logic
- Detailed sync logs and error reporting

## Documentation

- [Architecture Overview](./docs/ARCHITECTURE.md)
- [API Reference](./docs/API.md)
- [Adapter Development Guide](./docs/ADAPTERS.md)
- [Deployment Guide](./docs/DEPLOYMENT.md)

## Business Context

Runa Admin powers the backend for [askruna.ai](https://www.askruna.ai/), delivering:

- **20% average sales uplift** through AI-powered recommendations
- **100% automated product bundling** for outfit suggestions
- **10x faster trend response** with real-time fashion analysis

## License

Proprietary - All rights reserved
# runa-admin
