import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
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

  // Each user row IS one store (1:1 with the Shopify install row), so all
  // store fields live at the top level — no `stores: [...]` array.
  const user = {
    ...(existingByShop || {}),
    id: resolved.id,
    shop: resolved.shop,
    // Human-readable public website domain (e.g., "andreearaicu.com"), kept
    // alongside `shop` (the canonical *.myshopify.com / custom.<domain> id)
    // so the UI can show the name the merchant recognizes. Matches the field
    // name Shopify itself returns from /shop.json.
    domain: resolved.domain,
    storeName: existingByShop?.storeName || resolved.domain.split(".")[0],
    email: String(email).trim().toLowerCase(),
    name: name || String(email).split("@")[0],
    password: hashedPassword,
    platform: resolvedPlatform,
    role: existingByShop?.role || "user",
    status: existingByShop?.status || "pending",
    productsCount:
      existingByShop?.productsCount ?? existingByShop?.totalProducts ?? 0,
    lastSync:
      existingByShop?.lastSync || existingByShop?.syncStatus?.lastUpdated || null,
    createdAt: existingByShop?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (resolvedPlatform === "vtex") {
    user.vtexApiKey = vtexApiKey;
    user.vtexToken = vtexToken;
  }

  // Drop the legacy nested array if it was present on an old row — we now
  // store store fields at the top level.
  delete user.stores;

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
      domain: user.domain,
      platform: user.platform,
      email: user.email,
      name: user.name,
      role: user.role
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
      domain: user.domain,
      platform: user.platform,
      email: user.email,
      name: user.name,
      role: user.role || "user"
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

  // Session role lives on the JWT (so elevation via /auth/elevate survives a
  // reload), not on the DB row. Fall back to the stored role only if the JWT
  // doesn't carry one.
  const sessionRole = req.user.role || user.role || "user";

  res.json({
    id: user.id,
    shop: user.shop,
    domain: user.domain,
    platform: user.platform,
    email: user.email,
    name: user.name,
    role: sessionRole
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
      domain: user.domain,
      platform: user.platform,
      email: user.email,
      name: user.name,
      role: user.role || "user"
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
 * POST /api/auth/elevate
 * Body: { key }
 *
 * Trade the caller's regular session JWT for one that carries role: "superadmin".
 * Anyone who knows the SUPERADMIN_KEY env var can do this — the server enforces
 * absolutely nothing else. Treat that key like a password.
 *
 * Returns 404-ish silence if the key is wrong, so the endpoint can't be probed
 * for "is the feature enabled" without already having the key.
 */
router.post("/elevate", authenticate, asyncHandler(async (req, res) => {
  const expected = config.superadmin?.key;
  const provided = req.body?.key;

  if (!expected || !provided) {
    throw ApiError.unauthorized("Invalid key");
  }

  // Constant-time comparison to dodge timing-based key guessing.
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw ApiError.unauthorized("Invalid key");
  }

  const token = generateToken({
    userId: req.user.userId,
    shop: req.user.shop,
    email: req.user.email,
    role: "superadmin"
  });

  res.json({ token, role: "superadmin" });
}));

/**
 * POST /api/auth/exit-superadmin
 * Trade a superadmin session JWT for a regular one. Resolves the user's true
 * stored role from DynamoDB (defaulting to "user") so anyone whose row really
 * is `role: "superadmin"` keeps it; everyone else drops back to a normal user.
 *
 * Honors X-Impersonate-Shop while elevated, but the response always re-issues
 * the JWT for the *original* logged-in user (req.user.actor), not the
 * impersonated one.
 */
/**
 * GET /api/auth/find-shop?value=<anything>
 *
 * Superadmin-only helper for the "?shop=" / "?domain=" URL params. Takes
 * whatever the caller typed (a Shopify handle like `naomi.myshopify.com`,
 * a public domain like `naomi.com`, or even `https://naomi.com/foo`) and
 * returns the canonical row identifier the impersonation header expects.
 *
 * Resolution order (cheap → expensive):
 *   1. Strip protocol/path/www, lowercase.
 *   2. getUserByShop(value)              — direct GSI hit
 *   3. getUserByShop(`custom.<value>`)   — custom-platform shops
 *   4. getUserById(`offline_<value>`)    — partition-key direct read
 *   5. resolveShopId(value)              — Shopify storefront detection (slow)
 */
router.get("/find-shop", authenticate, asyncHandler(async (req, res) => {
  if (req.user.role !== "superadmin") {
    throw ApiError.forbidden("Only superadmins can resolve shops");
  }

  const raw = String(req.query.value || "").trim().toLowerCase();
  if (!raw) throw ApiError.badRequest("value is required");

  const clean = raw
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .replace(/\/+$/, "");

  let user =
    (await dynamodb.users.getUserByShop(clean)) ||
    (await dynamodb.users.getUserByShop(`custom.${clean}`)) ||
    (await dynamodb.users.getUserById(`offline_${clean}`)) ||
    (await dynamodb.users.getUserById(`offline_custom.${clean}`));

  // Last resort: hit the live storefront to detect Shopify (~1-3s).
  if (!user) {
    try {
      const resolved = await resolveShopId(clean);
      user = await dynamodb.users.getUserById(resolved.id);
    } catch {
      // ignore — handled below
    }
  }

  if (!user) throw ApiError.notFound("Shop not found");

  res.json({
    id: user.id,
    shop: user.shop,
    domain: user.domain || null,
    email: user.email || null
  });
}));

router.post("/exit-superadmin", authenticate, asyncHandler(async (req, res) => {
  // If the caller is impersonating, the original identity is on req.user.actor.
  const realUserId = req.user.actor || req.user.userId;
  const realShop = req.user.actorShop || req.user.shop;
  const realEmail = req.user.actorEmail || req.user.email;

  // Look up the row to recover the *stored* role (almost always "user").
  let storedRole = "user";
  try {
    const stored = await dynamodb.users.getUserById(realUserId);
    if (stored?.role && stored.role !== "superadmin") storedRole = stored.role;
    else if (stored?.role === "superadmin") storedRole = "superadmin";
  } catch {
    // Non-fatal — fall back to "user".
  }

  const token = generateToken({
    userId: realUserId,
    shop: realShop,
    email: realEmail,
    role: storedRole
  });

  res.json({ token, role: storedRole });
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
  const { shop, ts, hmac, email, name } = req.body || {};

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

  // Bake any merchant info Shopify already has (email/name from /shop.json)
  // into the token so the claim page can SSO without asking for anything.
  const claimPayload = { purpose: "claim", shop: cleanShop, id };
  if (typeof email === "string" && email.trim()) {
    claimPayload.email = email.trim().toLowerCase();
  }
  if (typeof name === "string" && name.trim()) {
    claimPayload.name = name.trim();
  }

  const claimToken = jwt.sign(claimPayload, config.claim.secret, {
    expiresIn: config.claim.ttl,
    jwtid: crypto.randomUUID()
  });

  const baseWebUrl = config.web.url.replace(/\/+$/, "");
  const url = `${baseWebUrl}/claim?token=${encodeURIComponent(claimToken)}`;

  res.json({
    url,
    expiresIn: config.claim.ttl,
    alreadyClaimed: Boolean(user.password)
  });
}));

/**
 * POST /api/auth/claim
 * Body: { token }
 * SSO-style auto-login: a valid claim token (signed by runa-admin after the
 * Shopify install side proved it owns the shop via HMAC of the access token)
 * is itself proof of identity. We don't ask the merchant for a password.
 *
 * If the row doesn't have an email yet, we adopt the email/name baked into
 * the token (passed by the Shopify install side from /shop.json). Password
 * stays unset — the merchant can set one later in Settings if they want
 * direct (non-Shopify) login at /login.
 */
router.post("/claim", asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  const decoded = verifyClaimToken(token);

  const user = await dynamodb.users.getUserById(decoded.id);
  if (!user) {
    throw ApiError.badRequest("This shop hasn't installed the Runa app yet.");
  }

  user.shop = user.shop || decoded.shop;
  user.domain = user.domain || user.shopDomain || user.shop || decoded.shop;
  user.storeName = user.storeName || (user.shop || "").split(".")[0];
  user.platform = user.platform || "shopify";
  user.role = user.role || "user";
  user.status = user.status || "pending";
  user.productsCount = user.productsCount ?? user.totalProducts ?? 0;
  user.lastSync = user.lastSync || user.syncStatus?.lastUpdated || null;

  // First time through: adopt the merchant info Shopify already has.
  if (!user.email && decoded.email) {
    user.email = String(decoded.email).trim().toLowerCase();
  }
  if (!user.name) {
    user.name =
      decoded.name ||
      (user.email ? user.email.split("@")[0] : (user.shop || "").split(".")[0]);
  }
  if (!user.claimedAt) {
    user.claimedAt = new Date().toISOString();
  }
  user.lastLoginAt = new Date().toISOString();
  user.updatedAt = new Date().toISOString();

  delete user.stores; // legacy field, no longer used

  await dynamodb.users.saveUser(user);

  const sessionToken = generateToken({
    userId: user.id,
    shop: user.shop,
    email: user.email,
    role: user.role
  });

  res.status(200).json({
    message: "Signed in",
    token: sessionToken,
    user: {
      id: user.id,
      shop: user.shop,
      domain: user.domain,
      platform: user.platform,
      email: user.email,
      name: user.name,
      role: user.role
    }
  });
}));

export default router;
