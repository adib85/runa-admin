import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOnboarding } from '../context/OnboardingContext';

export default function Home() {
  const {
    steps,
    completedSteps,
    currentStep,
    isComplete,
    loading,
    refresh,
    invalidateBackendCache
  } = useOnboarding();
  const navigate = useNavigate();

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

      <section className="border border-neutral-200 rounded-md p-8 mb-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-neutral-900">Get set up</h2>
          <div className="flex items-center gap-3">
            {isComplete ? (
              <span className="text-xs uppercase tracking-wide text-green-700 bg-green-50 border border-green-200 px-2 py-1 rounded">
                Complete
              </span>
            ) : (
              <span className="text-xs text-neutral-500">
                {completedSteps.size} of {steps.length} done
              </span>
            )}
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

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleCta}
                  disabled={!active.ctaPath}
                  className="btn btn-primary disabled:opacity-50"
                >
                  {active.done ? `Manage in ${ctaShortLabel(active)}` : active.ctaLabel}
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
            </div>
          </div>
        )}
      </section>

      {!isComplete && (
        <p className="text-xs text-neutral-500">
          The other tools become available once you finish setting up.
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

function ctaShortLabel(step) {
  if (step.id === 'enable-ai-stylist') return 'theme editor';
  return 'Shopify';
}
