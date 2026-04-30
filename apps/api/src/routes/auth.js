import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { dynamodb } from "@runa/core";
import { config } from "@runa/config";
import { generateToken, authenticate } from "../middleware/auth.js";
import { asyncHandler, ApiError } from "../middleware/error.js";
import { sendEmail, buildPasswordResetEmail } from "../services/mailer.js";
import { resolveShopId, shopToId } from "../services/shopDetector.js";

/**
 * Verify a claim token signed by the Shopify install backend.
 * Throws ApiError on any failure (expired, invalid, wrong purpose).
 * Returns the decoded payload { purpose, shop, id, jti, ... }.
 */
function verifyClaimToken(token) {
  if (!token) throw ApiError.badRequest("Missing claim token");
  let decoded;
  try {
    decoded = jwt.verify(token, config.claim.secret);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      throw ApiError.badRequest("This link has expired. Re-open the Runa app in your Shopify admin to get a fresh link.");
    }
    throw ApiError.badRequest("Invalid claim token");
  }
  if (decoded.purpose !== "claim") {
    throw ApiError.badRequest("Invalid claim token");
  }
  if (!decoded.shop && !decoded.id) {
    throw ApiError.badRequest("Claim token is missing a shop");
  }
  // Normalize: ensure id is in offline_<shop> format.
  const id = decoded.id || shopToId(decoded.shop);
  const shop = decoded.shop || (id.startsWith("offline_") ? id.slice(8) : id);
  return { ...decoded, id, shop };
}

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

  if (!storeUrl) {
    throw ApiError.badRequest("Store URL is required");
  }

  // Resolve any URL the user typed into a canonical shop / id pair so this
  // row is the SAME row the Shopify install side writes (id = "offline_<shop>").
  let resolved;
  try {
    resolved = await resolveShopId(storeUrl);
  } catch (err) {
    throw ApiError.badRequest(`Invalid store URL: ${err.message}`);
  }

  // Prefer the platform we detected from the live storefront. Fall back to
  // whatever the client said only when detection couldn't classify the store.
  const clientPlatform = platform ? String(platform).toLowerCase() : null;
  const resolvedPlatform =
    resolved.platform === "custom" && clientPlatform
      ? clientPlatform
      : resolved.platform;

  if (resolvedPlatform === "vtex") {
    if (!vtexApiKey || !vtexToken) {
      throw ApiError.badRequest("VTEX API Key and Token are required for VTEX platform");
    }
  }

  // Email is treated as contact metadata (one human can own multiple shops),
  // so we only enforce uniqueness on the shop identifier itself.
  const existingByShop =
    (await dynamodb.users.getUserById(resolved.id)) ||
    (await dynamodb.users.getUserByShop(resolved.shop));

  if (existingByShop && existingByShop.password) {
    throw ApiError.conflict("An admin account for this store already exists");
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const initialStore = {
    id: uuidv4(),
    platform: resolvedPlatform,
    domain: resolved.domain,
    name: resolved.domain.split(".")[0],
    status: "pending",
    productsCount: 0,
    lastSync: null,
    createdAt: new Date().toISOString()
  };
  if (resolvedPlatform === "vtex") {
    initialStore.vtexApiKey = vtexApiKey;
    initialStore.vtexToken = vtexToken;
  }

  // Merge admin fields onto the existing Shopify-installed row, or create a new one.
  const user = {
    ...(existingByShop || {}),
    id: resolved.id,
    shop: resolved.shop,
    email: String(email).trim().toLowerCase(),
    name: name || String(email).split("@")[0],
    password: hashedPassword,
    platform: resolvedPlatform,
    role: existingByShop?.role || "user",
    stores: existingByShop?.stores?.length
      ? existingByShop.stores
      : [initialStore],
    createdAt: existingByShop?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await dynamodb.users.saveUser(user);

  const token = generateToken({
    userId: user.id,
    shop: user.shop,
    email: user.email,
    role: user.role
  });

  res.status(201).json({
    message: existingByShop
      ? "Admin account linked to existing store"
      : "User created successfully",
    token,
    user: {
      id: user.id,
      shop: user.shop,
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
  // The frontend posts { storeUrl, password }. Older clients may still send
  // { email } as the identifier — accept either field name.
  const { storeUrl, email, password } = req.body;
  const rawIdentifier = storeUrl || email;

  if (!rawIdentifier || !password) {
    throw ApiError.badRequest("Store URL and password are required");
  }

  let user = null;
  try {
    const resolved = await resolveShopId(rawIdentifier);
    user =
      (await dynamodb.users.getUserById(resolved.id)) ||
      (await dynamodb.users.getUserByShop(resolved.shop));
  } catch {
    // Resolution failure → treat as invalid credentials below.
  }

  if (!user || !user.password) {
    throw ApiError.unauthorized("Invalid credentials");
  }

  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) {
    throw ApiError.unauthorized("Invalid credentials");
  }

  const token = generateToken({
    userId: user.id,
    shop: user.shop,
    email: user.email,
    role: user.role || "user"
  });

  res.json({
    token,
    user: {
      id: user.id,
      shop: user.shop,
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
  let user = null;
  if (req.user.userId) {
    user = await dynamodb.users.getUserById(req.user.userId);
  }
  if (!user && req.user.shop) {
    user = await dynamodb.users.getUserByShop(req.user.shop);
  }

  if (!user) {
    throw ApiError.notFound("User not found");
  }

  res.json({
    id: user.id,
    shop: user.shop,
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
  const { email, storeUrl } = req.body;

  if (!email || !storeUrl) {
    throw ApiError.badRequest("Email and store URL are required");
  }

  const cleanEmail = String(email).trim().toLowerCase();
  // Generic response — never reveal whether the (email, shop) pair exists.
  const responseBody = {
    message:
      "If an account exists for that store, we've sent a password reset link."
  };

  let user = null;
  try {
    const resolved = await resolveShopId(storeUrl);
    user =
      (await dynamodb.users.getUserById(resolved.id)) ||
      (await dynamodb.users.getUserByShop(resolved.shop));
  } catch {
    return res.json(responseBody);
  }

  // Only proceed if the (shop, email) pair matches.
  if (!user || !user.email || user.email.toLowerCase() !== cleanEmail) {
    return res.json(responseBody);
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  user.passwordResetToken = hashToken(rawToken);
  user.passwordResetExpires = Date.now() + RESET_TOKEN_TTL_MS;
  await dynamodb.users.saveUser(user);

  const resetUrl = `${config.web.url.replace(/\/+$/, "")}/reset-password?token=${rawToken}&id=${encodeURIComponent(user.id)}`;

  try {
    const { subject, html, text } = buildPasswordResetEmail({
      resetUrl,
      email: cleanEmail,
      shop: user.shop || user.id
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
  const { token, id, email, password } = req.body;

  if (!token || !password || (!id && !email)) {
    throw ApiError.badRequest("Token, account id and new password are required");
  }
  if (String(password).length < 6) {
    throw ApiError.badRequest("Password must be at least 6 characters");
  }

  // Prefer the explicit id baked into the reset link; fall back to email
  // for backward compatibility with old links.
  let user = null;
  if (id) {
    user = await dynamodb.users.getUserById(String(id));
  } else if (email) {
    user = await dynamodb.users.getUserByEmail(String(email).trim().toLowerCase());
  }
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
    shop: user.shop,
    email: user.email,
    role: user.role || "user"
  });

  res.json({
    message: "Password updated",
    token: authToken,
    user: {
      id: user.id,
      shop: user.shop,
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
    shop: req.user.shop,
    email: req.user.email,
    role: req.user.role
  });

  res.json({ token });
}));

/**
 * POST /api/auth/claim-link
 * Server-to-server endpoint called by the Shopify install backend to mint a
 * fresh "set up your admin login" URL for a shop.
 *
 * Authentication: HMAC-SHA256 of `${shop}.${ts}` keyed by the shop's Shopify
 * access token (which both sides already have). No shared env var required.
 *
 * Body: { shop: string, ts: number, hmac: string }
 * Response: { url, expiresIn, alreadyClaimed }
 */
const HMAC_REPLAY_WINDOW_MS = 5 * 60 * 1000;

router.post("/claim-link", asyncHandler(async (req, res) => {
  const { shop, ts, hmac } = req.body || {};

  if (!shop || !ts || !hmac) {
    throw ApiError.badRequest("shop, ts and hmac are required");
  }

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) {
    throw ApiError.badRequest("Invalid ts");
  }
  if (Math.abs(Date.now() - tsNum) > HMAC_REPLAY_WINDOW_MS) {
    throw ApiError.unauthorized("Request timestamp out of range");
  }

  const cleanShop = String(shop).trim().toLowerCase();
  const id = shopToId(cleanShop);
  const user = await dynamodb.users.getUserById(id);
  if (!user || !user.accessToken) {
    // Don't leak whether the shop exists or simply has no token yet.
    throw ApiError.unauthorized("Unauthorized");
  }

  const expected = crypto
    .createHmac("sha256", user.accessToken)
    .update(`${cleanShop}.${tsNum}`)
    .digest("hex");

  const provided = String(hmac);
  let providedBuf, expectedBuf;
  try {
    providedBuf = Buffer.from(provided, "hex");
    expectedBuf = Buffer.from(expected, "hex");
  } catch {
    throw ApiError.unauthorized("Unauthorized");
  }
  if (
    providedBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(providedBuf, expectedBuf)
  ) {
    throw ApiError.unauthorized("Unauthorized");
  }

  const claimToken = jwt.sign(
    { purpose: "claim", shop: cleanShop, id },
    config.claim.secret,
    { expiresIn: config.claim.ttl, jwtid: crypto.randomUUID() }
  );

  const baseWebUrl = config.web.url.replace(/\/+$/, "");
  const url = `${baseWebUrl}/claim?token=${encodeURIComponent(claimToken)}`;

  res.json({
    url,
    expiresIn: config.claim.ttl,
    alreadyClaimed: Boolean(user.password)
  });
}));

/**
 * GET /api/auth/claim
 * Verify a claim token and return basic info about the shop being claimed.
 * Used by the /claim page to render "Set up admin login for <shop>".
 */
router.get("/claim", asyncHandler(async (req, res) => {
  const decoded = verifyClaimToken(req.query.token);
  const user = await dynamodb.users.getUserById(decoded.id);
  if (!user) {
    throw ApiError.badRequest("This shop hasn't installed the Runa app yet.");
  }
  res.json({
    shop: user.shop || decoded.shop,
    id: user.id,
    alreadyClaimed: Boolean(user.password),
    suggestedEmail: user.email || null
  });
}));

/**
 * POST /api/auth/claim
 * Body: { token, email, password, name? }
 * Attaches admin credentials to the shop row created by the Shopify install
 * and signs the user straight in.
 */
router.post("/claim", asyncHandler(async (req, res) => {
  const { token, email, password, name } = req.body;

  if (!email || !password) {
    throw ApiError.badRequest("Email and password are required");
  }
  if (String(password).length < 6) {
    throw ApiError.badRequest("Password must be at least 6 characters");
  }

  const decoded = verifyClaimToken(token);
  const user = await dynamodb.users.getUserById(decoded.id);
  if (!user) {
    throw ApiError.badRequest("This shop hasn't installed the Runa app yet.");
  }
  if (user.password) {
    throw ApiError.conflict(
      "This account has already been set up. Please sign in with your store URL and password."
    );
  }

  const cleanEmail = String(email).trim().toLowerCase();
  user.email = cleanEmail;
  user.name = name || (user.name || cleanEmail.split("@")[0]);
  user.password = await bcrypt.hash(String(password), 10);
  user.role = user.role || "user";
  user.platform = user.platform || "shopify";
  user.shop = user.shop || decoded.shop;
  user.claimedAt = new Date().toISOString();
  user.updatedAt = new Date().toISOString();

  // Make sure there's at least one store entry for the dashboard.
  if (!Array.isArray(user.stores) || user.stores.length === 0) {
    user.stores = [
      {
        id: uuidv4(),
        platform: "shopify",
        domain: user.shop,
        name: (user.shop || "").split(".")[0],
        status: "pending",
        productsCount: user.totalProducts || 0,
        lastSync: user.syncStatus?.lastUpdated || null,
        createdAt: new Date().toISOString()
      }
    ];
  }

  await dynamodb.users.saveUser(user);

  const sessionToken = generateToken({
    userId: user.id,
    shop: user.shop,
    email: user.email,
    role: user.role
  });

  res.status(201).json({
    message: "Account claimed successfully",
    token: sessionToken,
    user: {
      id: user.id,
      shop: user.shop,
      email: user.email,
      name: user.name,
      role: user.role,
      stores: user.stores
    }
  });
}));

export default router;
