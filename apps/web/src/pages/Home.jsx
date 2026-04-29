import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOnboarding } from '../context/OnboardingContext';

export default function Home() {
  const { steps, completedSteps, currentStep, markStepComplete, isComplete } =
    useOnboarding();
  const navigate = useNavigate();

  const [activeId, setActiveId] = useState(currentStep?.id || steps[0].id);

  useEffect(() => {
    if (currentStep && !completedSteps.has(activeId)) return;
    if (currentStep) setActiveId(currentStep.id);
  }, [currentStep, activeId, completedSteps]);

  const active = steps.find((s) => s.id === activeId) || steps[0];

  function handleCta() {
    markStepComplete(active.id);
    if (!active.ctaPath) return;
    if (active.ctaExternal || /^https?:\/\//i.test(active.ctaPath)) {
      window.open(active.ctaPath, '_blank', 'noopener,noreferrer');
    } else {
      navigate(active.ctaPath);
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
          {isComplete ? (
            <span className="text-xs uppercase tracking-wide text-green-700 bg-green-50 border border-green-200 px-2 py-1 rounded">
              Complete
            </span>
          ) : (
            <span className="text-xs text-neutral-500">
              {completedSteps.size} of {steps.length} done
            </span>
          )}
        </div>

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
            <p className="text-sm text-neutral-600 mb-6">{active.description}</p>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleCta}
                className="btn btn-primary"
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
          </div>
        </div>
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
