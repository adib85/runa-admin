import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { api } from '../services/api';

const SuperAdminContext = createContext(null);

const LEGACY_FLAG_KEY = 'runa_superadmin';
const IMPERSONATE_KEY = 'runa:impersonateShop';

function readImpersonate() {
  try {
    return localStorage.getItem(IMPERSONATE_KEY) || null;
  } catch {
    return null;
  }
}

function writeImpersonate(shop) {
  try {
    if (shop) localStorage.setItem(IMPERSONATE_KEY, shop);
    else localStorage.removeItem(IMPERSONATE_KEY);
  } catch {
    // ignore
  }
}

function normalizeShop(value) {
  if (!value) return null;
  return String(value)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function SuperAdminProvider({ children }) {
  const location = useLocation();
  const { user, setUser } = useAuth();

  // Authoritative: superadmin if the JWT-issued user has role === 'superadmin'.
  // Backend won't honor /activate or impersonation without it.
  const isJwtSuperAdmin = user?.role === 'superadmin';

  // Legacy fallback for dev — kept so the URL trick (?superadmin=true) still
  // toggles extra UI bits, but it grants ZERO backend privileges.
  const [legacyFlag, setLegacyFlag] = useState(
    () => localStorage.getItem(LEGACY_FLAG_KEY) === 'true'
  );

  const [impersonatedShop, setImpersonatedShop] = useState(() =>
    readImpersonate()
  );

  // Trade the current session JWT for one with role: "superadmin" by hitting
  // /api/auth/elevate with the SUPERADMIN_KEY. Triggered when the URL contains
  // `?superadmin=<key>` (and the value isn't the literal "true").
  //
  // After a successful elevation we hard-reload the page. This is the simplest
  // way to make sure every downstream context (OnboardingProvider etc.)
  // re-initializes with the new JWT in `localStorage` AND with whatever
  // impersonation header was set in the same URL, with no race.
  const elevate = useCallback(
    async (key) => {
      try {
        const res = await api.post('/auth/elevate', { key });
        const newToken = res.data?.token;
        if (newToken) {
          localStorage.setItem('token', newToken);
          if (typeof setUser === 'function' && user) {
            setUser({ ...user, role: 'superadmin' });
          }
          // Reload so onboarding/status etc. re-fetch with the new JWT and
          // any X-Impersonate-Shop header set from the same URL.
          window.location.reload();
        }
      } catch (err) {
        console.error('Superadmin elevation failed:', err);
      }
    },
    [setUser, user]
  );

  // Resolve a user-typed shop/domain ("naomi.com", "naomi.myshopify.com",
  // "https://naomi.com/foo", "custom.brand.com") into the canonical shop
  // handle the impersonation header needs. Requires JWT to already be
  // superadmin (the endpoint enforces that). Falls back to the raw value
  // if the resolve call fails — harmless.
  const resolveShop = useCallback(async (value) => {
    if (!value) return null;
    const normalized = normalizeShop(value);
    try {
      const res = await api.get(
        `/auth/find-shop?value=${encodeURIComponent(normalized)}`
      );
      return res.data?.shop || normalized;
    } catch (err) {
      console.error('Could not resolve shop:', err);
      return normalized;
    }
  }, []);

  // Pick up `?superadmin=…`, `?shop=…` / `?domain=…`, `?stopShop` from any URL.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    let touched = false;

    if (params.has('superadmin')) {
      const value = params.get('superadmin');
      // ?superadmin=true is the legacy client-only toggle (no backend power).
      // Any other value is treated as the SUPERADMIN_KEY and exchanged for a
      // real superadmin JWT via /auth/elevate.
      if (value === 'true') {
        setLegacyFlag(true);
        localStorage.setItem(LEGACY_FLAG_KEY, 'true');
      } else if (value) {
        elevate(value);
      }
      params.delete('superadmin');
      touched = true;
    }

    // ?shop= and ?domain= are interchangeable — the value can be a Shopify
    // handle ("naomi.myshopify.com") or a public domain ("naomi.com").
    const target = params.get('shop') || params.get('domain');
    if (target) {
      // Optimistically stash the typed value so the badge shows immediately;
      // resolve() then upgrades it to the canonical shop in the background.
      const normalized = normalizeShop(target);
      setImpersonatedShop(normalized);
      writeImpersonate(normalized);
      // Only attempt resolution if we already have a superadmin JWT in this
      // tab; otherwise the URL likely contains ?superadmin=<key> too and the
      // page will reload after elevation, at which point the unresolved value
      // will be passed to the backend impersonation lookup directly.
      if (isJwtSuperAdmin) {
        resolveShop(normalized).then((canonical) => {
          if (canonical && canonical !== normalized) {
            setImpersonatedShop(canonical);
            writeImpersonate(canonical);
          }
        });
      }
      params.delete('shop');
      params.delete('domain');
      touched = true;
    }

    if (params.has('stopShop')) {
      setImpersonatedShop(null);
      writeImpersonate(null);
      params.delete('stopShop');
      touched = true;
    }

    if (touched) {
      // Clean the params from the URL bar without reloading.
      const cleaned = params.toString();
      const newUrl =
        window.location.pathname + (cleaned ? `?${cleaned}` : '');
      if (newUrl !== window.location.pathname + window.location.search) {
        window.history.replaceState({}, '', newUrl);
      }
    }
  }, [location, elevate, resolveShop, isJwtSuperAdmin]);

  // If the logged-in user loses superadmin (or logs out), drop impersonation.
  useEffect(() => {
    if (!isJwtSuperAdmin && impersonatedShop) {
      setImpersonatedShop(null);
      writeImpersonate(null);
    }
  }, [isJwtSuperAdmin, impersonatedShop]);

  // After elevation completes, if the impersonation value still looks like a
  // raw public domain (e.g. "naomi.com" rather than "naomi.myshopify.com" or
  // "custom.naomi.com"), upgrade it to the canonical shop. Idempotent — a
  // value that's already canonical resolves to itself.
  useEffect(() => {
    if (!isJwtSuperAdmin || !impersonatedShop) return;
    const looksCanonical =
      impersonatedShop.endsWith('.myshopify.com') ||
      impersonatedShop.startsWith('custom.');
    if (looksCanonical) return;

    let cancelled = false;
    resolveShop(impersonatedShop).then((canonical) => {
      if (cancelled || !canonical) return;
      if (canonical !== impersonatedShop) {
        setImpersonatedShop(canonical);
        writeImpersonate(canonical);
        // Reload so contexts re-fetch with the corrected impersonation value.
        window.location.reload();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isJwtSuperAdmin, impersonatedShop, resolveShop]);

  const startImpersonating = useCallback(
    (shop) => {
      if (!isJwtSuperAdmin) return;
      const normalized = normalizeShop(shop);
      setImpersonatedShop(normalized);
      writeImpersonate(normalized);
    },
    [isJwtSuperAdmin]
  );

  const stopImpersonating = useCallback(() => {
    setImpersonatedShop(null);
    writeImpersonate(null);
  }, []);

  const disableSuperAdmin = useCallback(() => {
    setLegacyFlag(false);
    localStorage.removeItem(LEGACY_FLAG_KEY);
    setImpersonatedShop(null);
    writeImpersonate(null);
  }, []);

  /**
   * Fully exit superadmin mode:
   *   1. Drop the impersonated shop (header gone next request).
   *   2. Clear the legacy URL flag.
   *   3. Trade the superadmin JWT for a regular one (server resolves the
   *      original user's stored role) and reload so every context boots
   *      fresh as a normal user.
   */
  const exitSuperAdmin = useCallback(async () => {
    setImpersonatedShop(null);
    writeImpersonate(null);
    setLegacyFlag(false);
    localStorage.removeItem(LEGACY_FLAG_KEY);

    if (isJwtSuperAdmin) {
      try {
        const res = await api.post('/auth/exit-superadmin');
        if (res.data?.token) {
          localStorage.setItem('token', res.data.token);
        }
      } catch (err) {
        console.error('Failed to exit superadmin:', err);
      }
    }
    window.location.reload();
  }, [isJwtSuperAdmin]);

  const value = useMemo(
    () => ({
      isSuperAdmin: isJwtSuperAdmin || legacyFlag,
      isJwtSuperAdmin,
      impersonatedShop,
      startImpersonating,
      stopImpersonating,
      disableSuperAdmin,
      exitSuperAdmin
    }),
    [
      isJwtSuperAdmin,
      legacyFlag,
      impersonatedShop,
      startImpersonating,
      stopImpersonating,
      disableSuperAdmin,
      exitSuperAdmin
    ]
  );

  return (
    <SuperAdminContext.Provider value={value}>
      {children}
    </SuperAdminContext.Provider>
  );
}

export function useSuperAdmin() {
  const context = useContext(SuperAdminContext);
  if (!context) {
    throw new Error('useSuperAdmin must be used within a SuperAdminProvider');
  }
  return context;
}
