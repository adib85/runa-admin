import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "runa-admin-secret-change-in-production";

/**
 * Authentication middleware
 * Verifies JWT token from Authorization header.
 *
 * Superadmin impersonation:
 *   If the caller's JWT has role === "superadmin" AND the request includes an
 *   X-Impersonate-Shop header (e.g. "andreearaicu.myshopify.com"), we swap
 *   `req.user.userId` and `req.user.shop` to point at that target shop. The
 *   superadmin's own identity is preserved on `req.user.actor` / `req.user.actorEmail`
 *   for audit logging. All downstream handlers can stay oblivious — they just
 *   read req.user.userId/shop the same way they always do.
 */
export function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;

    const impersonate = req.headers["x-impersonate-shop"];
    if (impersonate && req.user.role === "superadmin") {
      const targetShop = String(impersonate).trim().toLowerCase();
      if (targetShop) {
        req.user.actor = decoded.userId;
        req.user.actorEmail = decoded.email;
        req.user.actorShop = decoded.shop;
        req.user.shop = targetShop;
        req.user.userId = targetShop.startsWith("offline_")
          ? targetShop
          : `offline_${targetShop}`;
        req.user.impersonating = true;
      }
    }

    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }
}

/**
 * Generate JWT token
 */
export function generateToken(payload, expiresIn = "7d") {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

/**
 * Optional authentication - doesn't fail if no token
 */
export function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next();
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
  } catch (error) {
    // Ignore invalid token, proceed without user
  }

  next();
}

export default { authenticate, generateToken, optionalAuth };
