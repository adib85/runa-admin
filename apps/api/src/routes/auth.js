import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { dynamodb } from "@runa/core";
import { config } from "@runa/config";
import { generateToken, authenticate } from "../middleware/auth.js";
import { asyncHandler, ApiError } from "../middleware/error.js";
import { sendEmail, buildPasswordResetEmail } from "../services/mailer.js";

const router = Router();

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

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
    throw ApiError.badRequest("Email or website and password are required");
  }

  // Identifier may be an email (contains @) or a shop domain
  const identifier = String(email).trim().toLowerCase();
  const isEmail = identifier.includes("@");

  let user = isEmail
    ? await dynamodb.users.getUserByEmail(identifier)
    : await dynamodb.users.getUserByShop(identifier);

  // Fallback: if shop lookup misses, try matching against the user's stores
  if (!user && !isEmail) {
    user = await dynamodb.users.getUserByEmail(identifier);
  }

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
 * POST /api/auth/forgot-password
 * Generate a password reset token and email it to the user.
 * Always returns 200 to avoid leaking which emails exist.
 */
router.post("/forgot-password", asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    throw ApiError.badRequest("Email is required");
  }

  const cleanEmail = String(email).trim().toLowerCase();
  const responseBody = {
    message:
      "If an account exists for that email, we've sent a password reset link."
  };

  const user = await dynamodb.users.getUserByEmail(cleanEmail);
  if (!user) {
    return res.json(responseBody);
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  user.passwordResetToken = hashToken(rawToken);
  user.passwordResetExpires = Date.now() + RESET_TOKEN_TTL_MS;
  await dynamodb.users.saveUser(user);

  const resetUrl = `${config.web.url.replace(/\/+$/, "")}/reset-password?token=${rawToken}&email=${encodeURIComponent(cleanEmail)}`;

  try {
    const { subject, html, text } = buildPasswordResetEmail({
      resetUrl,
      email: cleanEmail
    });
    await sendEmail({ to: cleanEmail, subject, html, text });
  } catch (err) {
    console.error("Failed to send password reset email:", err?.response?.body || err);
    throw ApiError.internal("Failed to send password reset email");
  }

  res.json(responseBody);
}));

/**
 * POST /api/auth/reset-password
 * Verify the reset token and set a new password.
 */
router.post("/reset-password", asyncHandler(async (req, res) => {
  const { token, email, password } = req.body;

  if (!token || !email || !password) {
    throw ApiError.badRequest("Token, email and new password are required");
  }
  if (String(password).length < 6) {
    throw ApiError.badRequest("Password must be at least 6 characters");
  }

  const cleanEmail = String(email).trim().toLowerCase();
  const user = await dynamodb.users.getUserByEmail(cleanEmail);
  if (!user) {
    throw ApiError.badRequest("Invalid or expired reset link");
  }

  const tokenHash = hashToken(String(token));
  if (
    !user.passwordResetToken ||
    user.passwordResetToken !== tokenHash ||
    !user.passwordResetExpires ||
    Date.now() > Number(user.passwordResetExpires)
  ) {
    throw ApiError.badRequest("Invalid or expired reset link");
  }

  user.password = await bcrypt.hash(String(password), 10);
  delete user.passwordResetToken;
  delete user.passwordResetExpires;
  await dynamodb.users.saveUser(user);

  const authToken = generateToken({
    userId: user.id,
    email: user.email,
    role: user.role || "user"
  });

  res.json({
    message: "Password updated",
    token: authToken,
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
