import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOnboarding } from '../context/OnboardingContext';
import { useSuperAdmin } from '../context/SuperAdminContext';

export default function Home() {
  const {
    steps,
    completedSteps,
    currentStep,
    isComplete,
    aiStylistReady,
    loading,
    refresh,
    invalidateBackendCache,
    activate,
    deactivate
  } = useOnboarding();
  const { isSuperAdmin } = useSuperAdmin();
  const navigate = useNavigate();

  const [activating, setActivating] = useState(false);

  async function handleActivate() {
    setActivating(true);
    try {
      await activate();
    } catch (err) {
      alert(err.message || 'Failed to activate');
    } finally {
      setActivating(false);
    }
  }

  async function handleDeactivate() {
    setActivating(true);
    try {
      await deactivate();
    } catch (err) {
      alert(err.message || 'Failed to deactivate');
    } finally {
      setActivating(false);
    }
  }

  const [activeId, setActiveId] = useState(currentStep?.id || steps[0]?.id);
  const [refreshing, setRefreshing] = useState(false);

  // Auto-follow whichever step is incomplete (so when the user finishes
  // step 1, the right pane jumps to step 2).
  useEffect(() => {
    if (!currentStep) return;
    if (!completedSteps.has(activeId)) return;
    setActiveId(currentStep.id);
  }, [currentStep, activeId, completedSteps]);

  // When the tab gets re-focused after the merchant goes off to do something
  // in Shopify (theme editor / app store), re-check status quietly.
  useEffect(() => {
    function onFocus() {
      refresh({ silent: true });
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const active =
    steps.find((s) => s.id === activeId) || currentStep || steps[0];

  function handleCta() {
    if (!active?.ctaPath) return;
    // Tell the backend its 5-min cache is about to be stale — the merchant is
    // about to either install the app or toggle the embed.
    invalidateBackendCache();
    if (active.ctaExternal || /^https?:\/\//i.test(active.ctaPath)) {
      window.open(active.ctaPath, '_blank', 'noopener,noreferrer');
    } else {
      navigate(active.ctaPath);
    }
  }

  async function handleRecheck() {
    setRefreshing(true);
    try {
      await refresh({ bypassCache: true, silent: true });
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <h1 className="page-title">Home</h1>
      </div>

      {isComplete ? (
        <section className="border border-neutral-200 rounded-md px-6 py-4 mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center justify-center w-6 h-6">
              <svg
                className="w-5 h-5 text-neutral-900"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <circle cx="12" cy="12" r="10" strokeWidth={1.5} />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 12.5l3 3 5-6"
                />
              </svg>
            </span>
            <h2 className="text-base font-semibold text-neutral-900">
              Get set up
            </h2>
          </div>
          <span className="text-sm text-neutral-500">Completed</span>
        </section>
      ) : (
      <section className="border border-neutral-200 rounded-md p-8 mb-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-neutral-900">Get set up</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-neutral-500">
              {completedSteps.size} of {steps.length} done
            </span>
            <button
              type="button"
              onClick={handleRecheck}
              disabled={refreshing}
              className="text-xs text-neutral-500 hover:text-neutral-900 underline disabled:opacity-50"
            >
              {refreshing ? 'Re-checking…' : 'Re-check'}
            </button>
          </div>
        </div>

        {loading && completedSteps.size === 0 ? (
          <div className="flex items-center justify-center py-8">
            <div className="spinner" />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-8">
            <ul className="space-y-1">
              {steps.map((step) => {
                const done = completedSteps.has(step.id);
                const isActive = step.id === activeId;
                return (
                  <li key={step.id}>
                    <button
                      type="button"
                      onClick={() => setActiveId(step.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded text-left text-sm transition-colors ${
                        isActive
                          ? 'bg-neutral-100 text-neutral-900 font-medium'
                          : 'text-neutral-700 hover:bg-neutral-50'
                      }`}
                    >
                      <StepIcon done={done} />
                      <span>{step.title}</span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <div>
              <div className="flex items-center gap-3 mb-2">
                <h3 className="text-base font-semibold text-neutral-900">
                  {active.heading}
                </h3>
                {active.badge && (
                  <span className="text-xs text-neutral-500 border border-neutral-200 rounded px-2 py-0.5">
                    {active.badge}
                  </span>
                )}
              </div>
              <p className="text-sm text-neutral-600 mb-4">
                {active.description}
              </p>

              <StepStatus active={active} />

              {!active.done && (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleCta}
                    disabled={!active.ctaPath}
                    className="btn btn-primary disabled:opacity-50"
                  >
                    {active.ctaLabel}
                    <svg
                      className="w-4 h-4 ml-2"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.8}
                        d="M14 3h7v7m0-7L10 14m-7 7h7v-7"
                      />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
      )}

      {/* Training card — shown once the merchant finished setup but the AI
          Stylist hasn't been flipped live yet. Also shown to superadmins
          (so they can manually flip it). */}
      {isComplete && (!aiStylistReady || isSuperAdmin) && (
        <section className="border border-neutral-200 rounded-md p-8 mb-8">
          <h2 className="text-lg font-semibold text-neutral-900 mb-3">
            Training your AI Stylist
          </h2>
          {aiStylistReady ? (
            <p className="text-sm text-neutral-600">
              Runa is live on your storefront.
            </p>
          ) : (
            <>
              <p className="text-sm text-neutral-600 mb-2">
                We're training Runa on your products and brand voice — this
                takes 24–48 hours.
              </p>
              <p className="text-sm text-neutral-600">
                You'll get an email the moment it's ready.
              </p>
            </>
          )}

          {isSuperAdmin && (
            <div className="mt-6 pt-4 border-t border-neutral-100 flex items-center gap-3">
              <span className="text-2xs uppercase tracking-widest text-orange-600">
                Superadmin
              </span>
              {aiStylistReady ? (
                <button
                  type="button"
                  onClick={handleDeactivate}
                  disabled={activating}
                  className="text-xs text-orange-600 hover:text-orange-800 underline disabled:opacity-50"
                >
                  {activating ? 'Working…' : 'Mark as training again'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleActivate}
                  disabled={activating}
                  className="btn btn-primary text-xs"
                >
                  {activating ? 'Activating…' : 'Activate AI Stylist'}
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {!isComplete && (
        <p className="text-xs text-neutral-500">
          The other tools become available once you finish setting up.
        </p>
      )}
      {isComplete && !aiStylistReady && !isSuperAdmin && (
        <p className="text-xs text-neutral-500">
          The other tools become available once your AI Stylist finishes training.
        </p>
      )}
    </div>
  );
}

function StepIcon({ done }) {
  if (done) {
    return (
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-600 text-white">
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        </svg>
      </span>
    );
  }
  return <span className="inline-block w-5 h-5 rounded-full border border-neutral-300" />;
}

function StepStatus({ active }) {
  if (active.done) {
    return (
      <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2 mb-4">
        ✓ {active.id === 'connect-shopify'
          ? 'Your Shopify store is connected.'
          : `Live on ${active.themeName || 'your published theme'}.`}
      </p>
    );
  }
  // Friendlier copy for the most common pre-done states.
  if (active.id === 'enable-ai-stylist') {
    if (active.reason === 'shop-not-connected') {
      return (
        <p className="text-xs text-neutral-500 mb-4">
          Finish "Connect Shopify" first — we need it to read your theme.
        </p>
      );
    }
    if (active.reason === 'block-disabled') {
      return (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-4">
          The Runa app embed is added to your theme but currently turned off.
          Open the editor and toggle it on.
        </p>
      );
    }
  }
  return null;
}
