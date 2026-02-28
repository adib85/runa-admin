import { Router } from "express";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { dynamodb } from "@runa/core";
import { generateToken, authenticate } from "../middleware/auth.js";
import { asyncHandler, ApiError } from "../middleware/error.js";

const router = Router();

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post("/register", asyncHandler(async (req, res) => {
  const { email, password, name, storeUrl, platform, vtexApiKey, vtexToken } = req.body;

  if (!email || !password) {
    throw ApiError.badRequest("Email and password are required");
  }

  if (!storeUrl || !platform) {
    throw ApiError.badRequest("Store URL and platform are required");
  }

  // Validate VTEX credentials if platform is VTEX
  if (platform.toLowerCase() === 'vtex') {
    if (!vtexApiKey || !vtexToken) {
      throw ApiError.badRequest("VTEX API Key and Token are required for VTEX platform");
    }
  }

  // Check if user exists
  const existingUser = await dynamodb.users.getUserByEmail(email);
  if (existingUser) {
    throw ApiError.conflict("User already exists");
  }

  // Hash password
  const hashedPassword = await bcrypt.hash(password, 10);

  // Create initial store from registration
  const initialStore = {
    id: uuidv4(),
    platform: platform.toLowerCase(),
    domain: storeUrl,
    name: storeUrl.split('.')[0], // Use store URL as name
    status: "pending",
    productsCount: 0,
    lastSync: null,
    createdAt: new Date().toISOString()
  };

  // Add VTEX credentials if platform is VTEX
  if (platform.toLowerCase() === 'vtex') {
    initialStore.vtexApiKey = vtexApiKey;
    initialStore.vtexToken = vtexToken;
  }

  // Create user
  const user = {
    id: uuidv4(),
    email,
    name: name || email.split("@")[0],
    password: hashedPassword,
    platform,
    role: "user",
    stores: [initialStore],
    createdAt: new Date().toISOString()
  };

  await dynamodb.users.saveUser(user);

  // Generate token
  const token = generateToken({
    userId: user.id,
    email: user.email,
    role: user.role
  });

  res.status(201).json({
    message: "User created successfully",
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      stores: user.stores
    }
  });
}));

/**
 * POST /api/auth/login
 * Login user
 */
router.post("/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw ApiError.badRequest("Email and password are required");
  }

  // Find user by email
  const user = await dynamodb.users.getUserByEmail(email);
  if (!user) {
    throw ApiError.unauthorized("Invalid credentials");
  }

  // Verify password
  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) {
    throw ApiError.unauthorized("Invalid credentials");
  }

  // Generate token
  const token = generateToken({
    userId: user.id,
    email: user.email,
    role: user.role || "user"
  });

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role || "user",
      stores: user.stores || []
    }
  });
}));

/**
 * GET /api/auth/me
 * Get current user
 */
router.get("/me", authenticate, asyncHandler(async (req, res) => {
  const user = await dynamodb.users.getUserById(req.user.userId);

  if (!user) {
    throw ApiError.notFound("User not found");
  }

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role || "user",
    stores: user.stores || []
  });
}));

/**
 * POST /api/auth/refresh
 * Refresh token
 */
router.post("/refresh", authenticate, asyncHandler(async (req, res) => {
  const token = generateToken({
    userId: req.user.userId,
    email: req.user.email,
    role: req.user.role
  });

  res.json({ token });
}));

export default router;
