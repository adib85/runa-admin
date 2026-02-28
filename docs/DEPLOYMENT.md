# Deployment Guide

This guide covers deploying Runa Admin to various environments.

## Prerequisites

- Node.js 18+ installed
- AWS account with appropriate permissions
- Neo4j database (local or Aura)
- Domain name (for production)

## Environment Configuration

### Required Environment Variables

Create a `.env` file with the following variables:

```env
# ===================
# AWS Configuration
# ===================
AWS_ACCESS_KEY_ID=AKIAXXXXXXXXXXXXXXXX
AWS_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
AWS_REGION=us-east-1

# DynamoDB table names (optional, defaults provided)
DYNAMODB_USERS_TABLE=runa-users
DYNAMODB_CACHE_TABLE=runa-cache
DYNAMODB_LOGS_TABLE=runa-sync-logs

# S3 bucket for images
S3_BUCKET=runa-product-images

# ===================
# Neo4j Configuration
# ===================
NEO4J_URI=bolt://localhost:7687
# For Aura: neo4j+s://xxxxxxxx.databases.neo4j.io
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-secure-password

# ===================
# AI Services
# ===================
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# Optional: Google Gemini
GEMINI_API_KEY=AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# ===================
# Real-time (PubNub)
# ===================
PUBNUB_PUBLISH_KEY=pub-c-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
PUBNUB_SUBSCRIBE_KEY=sub-c-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# ===================
# Authentication
# ===================
JWT_SECRET=your-very-long-and-secure-jwt-secret-key-here
JWT_EXPIRES_IN=7d

# ===================
# Server Configuration
# ===================
PORT=3001
NODE_ENV=production

# Frontend URL (for CORS)
FRONTEND_URL=https://admin.askruna.ai

# API URL (for frontend to connect)
VITE_API_URL=https://api.admin.askruna.ai/api
```

## Local Development

### Quick Start

```bash
# Install dependencies
npm install

# Start development servers
npm run dev
```

This starts:
- API server on `http://localhost:3001`
- Web app on `http://localhost:5173`

### Running Services Separately

```bash
# Terminal 1: API server
npm run dev -w @runa/api

# Terminal 2: Web app
npm run dev -w @runa/web
```

## Production Build

### Build All Packages

```bash
# Build everything
npm run build

# Or build individually
npm run build -w @runa/core
npm run build -w @runa/adapters
npm run build -w @runa/api
npm run build -w @runa/web
```

### Output Locations

- Web app: `apps/web/dist/` (static files for CDN/nginx)
- API: `apps/api/src/` (Node.js application)

## Deployment Options

### Option 1: AWS (Recommended)

#### Infrastructure Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Route 53 (DNS)                           │
│         admin.askruna.ai → CloudFront                           │
│         api.admin.askruna.ai → ALB                              │
└─────────────────────────────────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
   ┌─────────────┐    ┌─────────────────┐    ┌───────────┐
   │ CloudFront  │    │ Application     │    │   S3      │
   │ (Web App)   │    │ Load Balancer   │    │ (Images)  │
   │             │    │                 │    │           │
   │ S3 Origin   │    │ ECS/EC2 Backend │    │           │
   └─────────────┘    └─────────────────┘    └───────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
   ┌─────────────┐    ┌─────────────────┐    ┌───────────┐
   │  DynamoDB   │    │     Neo4j       │    │  Secrets  │
   │  (Users)    │    │     Aura        │    │  Manager  │
   └─────────────┘    └─────────────────┘    └───────────┘
```

#### Step 1: Set Up DynamoDB Tables

```bash
# Create Users table
aws dynamodb create-table \
  --table-name runa-users \
  --attribute-definitions \
    AttributeName=id,AttributeType=S \
  --key-schema \
    AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

# Create Cache table with TTL
aws dynamodb create-table \
  --table-name runa-cache \
  --attribute-definitions \
    AttributeName=key,AttributeType=S \
  --key-schema \
    AttributeName=key,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

aws dynamodb update-time-to-live \
  --table-name runa-cache \
  --time-to-live-specification "Enabled=true, AttributeName=ttl"

# Create Logs table
aws dynamodb create-table \
  --table-name runa-sync-logs \
  --attribute-definitions \
    AttributeName=storeId,AttributeType=S \
    AttributeName=timestamp,AttributeType=S \
  --key-schema \
    AttributeName=storeId,KeyType=HASH \
    AttributeName=timestamp,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

#### Step 2: Set Up S3 Bucket

```bash
# Create bucket
aws s3 mb s3://runa-product-images --region us-east-1

# Enable public access for images (if needed)
aws s3api put-public-access-block \
  --bucket runa-product-images \
  --public-access-block-configuration \
    "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false"

# Add bucket policy for public read
aws s3api put-bucket-policy --bucket runa-product-images --policy '{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicReadGetObject",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::runa-product-images/*"
  }]
}'
```

#### Step 3: Deploy Web App to S3 + CloudFront

```bash
# Build web app
npm run build -w @runa/web

# Sync to S3
aws s3 sync apps/web/dist/ s3://runa-admin-web/ --delete

# Create CloudFront distribution (one-time)
aws cloudfront create-distribution \
  --origin-domain-name runa-admin-web.s3.amazonaws.com \
  --default-root-object index.html
```

#### Step 4: Deploy API to ECS

Create `Dockerfile` in `apps/api/`:

```dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy workspace files
COPY package*.json ./
COPY apps/api/package*.json ./apps/api/
COPY packages/core/package*.json ./packages/core/
COPY packages/adapters/package*.json ./packages/adapters/

# Install dependencies
RUN npm ci --workspace=@runa/api

# Copy source
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/

# Expose port
EXPOSE 3001

# Start server
CMD ["npm", "run", "start", "-w", "@runa/api"]
```

Build and push:

```bash
# Build Docker image
docker build -t runa-api -f apps/api/Dockerfile .

# Tag and push to ECR
aws ecr get-login-password | docker login --username AWS --password-stdin $ECR_REPO
docker tag runa-api:latest $ECR_REPO/runa-api:latest
docker push $ECR_REPO/runa-api:latest
```

### Option 2: Railway / Render

These platforms provide simpler deployment with automatic scaling.

#### Railway

1. Connect your GitHub repository
2. Add environment variables in Railway dashboard
3. Configure build settings:
   - Build command: `npm install && npm run build`
   - Start command: `npm run start -w @runa/api`

#### Render

Create `render.yaml`:

```yaml
services:
  # API Service
  - type: web
    name: runa-api
    env: node
    buildCommand: npm install && npm run build
    startCommand: npm run start -w @runa/api
    envVars:
      - key: NODE_ENV
        value: production
      - key: JWT_SECRET
        generateValue: true
      - key: AWS_ACCESS_KEY_ID
        sync: false
      - key: AWS_SECRET_ACCESS_KEY
        sync: false
      # ... other env vars

  # Web App (Static)
  - type: web
    name: runa-web
    env: static
    buildCommand: npm install && npm run build -w @runa/web
    staticPublishPath: apps/web/dist
    routes:
      - type: rewrite
        source: /*
        destination: /index.html
```

### Option 3: VPS (DigitalOcean, Linode, etc.)

#### Using PM2

```bash
# Install PM2 globally
npm install -g pm2

# Build the project
npm run build

# Start API with PM2
pm2 start apps/api/src/index.js --name runa-api

# Configure PM2 to restart on reboot
pm2 startup
pm2 save
```

#### Using Nginx as Reverse Proxy

```nginx
# /etc/nginx/sites-available/runa-admin

# API
server {
    listen 80;
    server_name api.admin.askruna.ai;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}

# Web App
server {
    listen 80;
    server_name admin.askruna.ai;
    root /var/www/runa-admin/apps/web/dist;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /assets {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

Enable SSL with Certbot:

```bash
sudo certbot --nginx -d admin.askruna.ai -d api.admin.askruna.ai
```

## Database Setup

### Neo4j Aura (Recommended for Production)

1. Create a free Aura instance at [neo4j.com/aura](https://neo4j.com/aura/)
2. Note the connection URI and credentials
3. Update `.env` with Aura credentials:
   ```
   NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io
   NEO4J_USER=neo4j
   NEO4J_PASSWORD=generated-password
   ```

### Self-Hosted Neo4j

```bash
# Using Docker
docker run -d \
  --name neo4j \
  -p 7474:7474 -p 7687:7687 \
  -v neo4j-data:/data \
  -e NEO4J_AUTH=neo4j/your-password \
  neo4j:5
```

### Initialize Database Schema

```bash
# Run migrations (if implemented)
npm run db:migrate

# Or manually create constraints in Neo4j Browser:
# CREATE CONSTRAINT product_id FOR (p:Product) REQUIRE p.id IS UNIQUE
# CREATE CONSTRAINT store_id FOR (s:Store) REQUIRE s.id IS UNIQUE
# CREATE INDEX product_store FOR (p:Product) ON (p.storeId)
```

## Health Checks

The API provides health check endpoints:

```bash
# Basic health check
curl https://api.admin.askruna.ai/health
# Response: { "status": "ok" }

# Detailed health check
curl https://api.admin.askruna.ai/health/detailed
# Response: { "status": "ok", "database": "connected", "neo4j": "connected" }
```

## Monitoring

### CloudWatch (AWS)

Configure CloudWatch for:
- API response times
- Error rates
- Database latency
- Memory/CPU usage

### Application Logging

```bash
# View PM2 logs
pm2 logs runa-api

# Stream logs
pm2 logs runa-api --lines 100
```

## Troubleshooting

### Common Issues

**API returns 502 Bad Gateway**
- Check if the Node.js process is running
- Verify nginx proxy configuration
- Check application logs for errors

**Database connection failed**
- Verify credentials in `.env`
- Check network security groups / firewall rules
- Ensure database is running and accessible

**CORS errors**
- Update `FRONTEND_URL` in `.env` to match your domain
- Ensure API is setting proper CORS headers

**JWT errors**
- Ensure `JWT_SECRET` matches between API instances
- Check token expiration settings

### Debug Mode

Run API with debug logging:

```bash
DEBUG=runa:* npm run dev -w @runa/api
```

## Backup & Recovery

### DynamoDB Backups

```bash
# Create on-demand backup
aws dynamodb create-backup \
  --table-name runa-users \
  --backup-name runa-users-backup-$(date +%Y%m%d)

# Enable continuous backups (PITR)
aws dynamodb update-continuous-backups \
  --table-name runa-users \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true
```

### Neo4j Backups

```bash
# For self-hosted Neo4j
neo4j-admin database dump --to-path=/backups neo4j

# For Aura, use the built-in backup feature in the console
```

## Security Checklist

- [ ] All environment variables are set via secrets manager, not in code
- [ ] JWT secret is at least 32 characters and randomly generated
- [ ] HTTPS is enabled for all endpoints
- [ ] CORS is properly configured for allowed origins only
- [ ] Database credentials have minimal required permissions
- [ ] API rate limiting is enabled
- [ ] Input validation on all endpoints
- [ ] Security headers configured (Helmet.js)
- [ ] Regular dependency updates (npm audit)
