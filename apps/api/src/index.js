import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { existsSync } from "fs";
import { config } from "@runa/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = resolve(__dirname, "../../web/dist");

// Import routes
import authRoutes from "./routes/auth.js";
import storesRoutes from "./routes/stores.js";
import productsRoutes from "./routes/products.js";
import syncRoutes from "./routes/sync.js";
import aiRoutes from "./routes/ai.js";
import demoRoutes from "./routes/demo.js";

// Import middleware
import { errorHandler } from "./middleware/error.js";

const app = express();

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
  credentials: true
}));
app.use(morgan("dev"));
app.use(express.json());

// Root route (API info when no frontend built)
app.get("/", (req, res, next) => {
  if (existsSync(WEB_DIST)) return next();
  res.json({
    name: "Runa Admin API",
    version: "1.0.0",
    endpoints: {
      health: "/health",
      auth: "/api/auth",
      stores: "/api/stores",
      products: "/api/products",
      sync: "/api/sync"
    }
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/stores", storesRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/sync", syncRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/demo", demoRoutes);

// Serve frontend static files in production
if (existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(join(WEB_DIST, "index.html"));
  });
}

// Error handler
app.use(errorHandler);

// Start server
const PORT = config.server.port || 3001;

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                    RUNA ADMIN API                         ║
╠═══════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}                  ║
║  Environment: ${config.server.env.padEnd(40)}║
╚═══════════════════════════════════════════════════════════╝
  `);
});

export default app;
