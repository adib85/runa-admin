import { createContext, useContext, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'runa:onboarding:completedSteps';

export const ONBOARDING_STEPS = [
  {
    id: 'connect-shopify',
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
    title: 'Enable AI Stylist',
    badge: '1 min',
    heading: 'Turn on the Runa AI Stylist',
    description:
      'Let Runa\'s AI Stylist recommend personalized outfits and product bundles to your shoppers in real time.',
    ctaLabel: 'Enable AI Stylist',
    ctaPath: '/ai-stylist'
  }
];

const OnboardingContext = createContext(null);

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function OnboardingProvider({ children }) {
  const [completedSteps, setCompletedSteps] = useState(() => new Set(readStored()));

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(completedSteps)));
  }, [completedSteps]);

  const markStepComplete = (id) => {
    setCompletedSteps((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  const markStepIncomplete = (id) => {
    setCompletedSteps((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const resetOnboarding = () => setCompletedSteps(new Set());

  const value = useMemo(() => {
    const isComplete = ONBOARDING_STEPS.every((s) => completedSteps.has(s.id));
    const currentStep =
      ONBOARDING_STEPS.find((s) => !completedSteps.has(s.id)) || ONBOARDING_STEPS[0];
    return {
      steps: ONBOARDING_STEPS,
      completedSteps,
      isComplete,
      currentStep,
      markStepComplete,
      markStepIncomplete,
      resetOnboarding
    };
  }, [completedSteps]);

  return (
    <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>
  );
}

export function useOnboarding() {
  const context = useContext(OnboardingContext);
  if (!context) {
    throw new Error('useOnboarding must be used within an OnboardingProvider');
  }
  return context;
}
