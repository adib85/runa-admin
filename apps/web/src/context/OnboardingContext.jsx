import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react';
import { api } from '../services/api';
import { useSuperAdmin } from './SuperAdminContext';

/**
 * Static metadata for the onboarding steps. The "done" state for each step
 * comes from the backend, NOT from local clicks — see /api/onboarding/status.
 *
 * `field` is the key on the backend response (`connectShopify`, `enableAIStylist`)
 * whose `done: boolean` we read.
 */
export const ONBOARDING_STEPS = [
  {
    id: 'connect-shopify',
    field: 'connectShopify',
    title: 'Connect Shopify',
    badge: '2 mins',
    heading: 'Connect your Shopify store',
    description:
      'Connect your Shopify store so the AI Stylist can browse your products and suggest "Complete the look" outfits and bundles to your shoppers.',
    ctaLabel: 'Connect Shopify',
    ctaPath: 'https://apps.shopify.com/runa-ai-assistant',
    ctaExternal: true
  },
  {
    id: 'enable-ai-stylist',
    field: 'enableAIStylist',
    title: 'Enable AI Stylist',
    badge: '1 min',
    heading: 'Turn on the Runa AI Stylist',
    description:
      'Open your theme editor, toggle Runa AI Stylist on, and click Save. We\'ll detect it and unlock the rest of the dashboard.',
    ctaLabel: 'Open theme editor',
    // ctaPath is filled in dynamically from status.themeEditorUrl
    ctaExternal: true
  }
];

const OnboardingContext = createContext(null);

const EMPTY_STATUS = {
  shop: null,
  domain: null,
  platform: null,
  themeEditorUrl: null,
  connectShopify: { done: false },
  enableAIStylist: { done: false, reason: null }
};

export function OnboardingProvider({ children }) {
  const { impersonatedShop } = useSuperAdmin();
  const [status, setStatus] = useState(EMPTY_STATUS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async (opts = {}) => {
    const { bypassCache = false, silent = false } = opts;
    if (!silent) setLoading(true);
    try {
      const url = bypassCache
        ? '/onboarding/status?refresh=1'
        : '/onboarding/status';
      const res = await api.get(url);
      setStatus({ ...EMPTY_STATUS, ...(res.data || {}) });
      setError(null);
    } catch (err) {
      console.error('Onboarding status fetch failed:', err);
      setError(err.message || 'Failed to load onboarding status');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // Tell the backend to invalidate its 5-min cache for this shop. Useful
  // right after the merchant clicks "Open theme editor" — they're about to
  // change something, the next /status check should hit Shopify fresh.
  const invalidateBackendCache = useCallback(async () => {
    try {
      await api.post('/onboarding/recheck');
    } catch (err) {
      // Non-fatal — we'll still pass refresh=1 on the next read.
      console.error('Failed to invalidate onboarding cache:', err);
    }
  }, []);

  // Superadmin-only: flip the "live on storefront" flag for the current
  // (or impersonated) shop. Backend enforces the role check.
  const activate = useCallback(async () => {
    const res = await api.post('/onboarding/activate');
    setStatus((prev) => ({
      ...prev,
      aiStylistReady: true,
      aiStylistActivatedAt: res.data?.aiStylistActivatedAt || new Date().toISOString()
    }));
  }, []);

  const deactivate = useCallback(async () => {
    await api.post('/onboarding/deactivate');
    setStatus((prev) => ({
      ...prev,
      aiStylistReady: false,
      aiStylistActivatedAt: null
    }));
  }, []);

  // Re-fetch on mount AND whenever the superadmin switches which shop they
  // are viewing-as — the X-Impersonate-Shop header changes so the next
  // /onboarding/status returns a different row.
  useEffect(() => {
    refresh();
  }, [refresh, impersonatedShop]);

  const value = useMemo(() => {
    const completedSteps = new Set();
    for (const step of ONBOARDING_STEPS) {
      if (status?.[step.field]?.done) completedSteps.add(step.id);
    }

    // Decorate the static step metadata with dynamic state from the backend.
    const steps = ONBOARDING_STEPS.map((step) => {
      const stepStatus = status?.[step.field] || {};
      const merged = { ...step, ...stepStatus, done: stepStatus.done === true };
      // The "Enable AI Stylist" CTA targets the merchant's theme editor.
      if (step.id === 'enable-ai-stylist' && status?.themeEditorUrl) {
        merged.ctaPath = status.themeEditorUrl;
      }
      return merged;
    });

    const isComplete = ONBOARDING_STEPS.every((s) => completedSteps.has(s.id));
    const currentStep =
      steps.find((s) => !completedSteps.has(s.id)) || steps[0];
    const aiStylistReady = Boolean(status?.aiStylistReady);
    // The dashboard "fully unlocks" only once both setup is done AND a
    // superadmin has flipped the AI Stylist live flag (after training).
    const fullyReady = isComplete && aiStylistReady;

    return {
      status,
      loading,
      error,
      steps,
      completedSteps,
      currentStep,
      isComplete,
      aiStylistReady,
      fullyReady,
      refresh,
      invalidateBackendCache,
      activate,
      deactivate
    };
  }, [
    status,
    loading,
    error,
    refresh,
    invalidateBackendCache,
    activate,
    deactivate
  ]);

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding() {
  const context = useContext(OnboardingContext);
  if (!context) {
    throw new Error('useOnboarding must be used within an OnboardingProvider');
  }
  return context;
}
