import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';

const API_URL = '/api';
const RUNA_URL = 'https://www.askruna.ai';

const STEPS = [
  { key: 'scan', label: 'Scan' },
  { key: 'classify', label: 'Classify' },
  { key: 'style', label: 'Style' },
];

function getStepIndex(stepKey) {
  return STEPS.findIndex(s => s.key === stepKey);
}

// ─── Step Indicator ──────────────────────────────────────────────────

function StepIndicator({ currentStep, completedSteps }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-8">
      {STEPS.map((step, i) => {
        const isCompleted = completedSteps.has(step.key);
        const isCurrent = currentStep === step.key;
        const isActive = isCompleted || isCurrent;

        return (
          <div key={step.key} className="flex items-center">
            {i > 0 && (
              <div className={`w-16 h-px transition-colors duration-500 ${isActive ? 'bg-purple-500' : 'bg-neutral-700'}`} />
            )}
            <div className="flex flex-col items-center gap-2">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium transition-all duration-500 ${
                isCompleted
                  ? 'bg-purple-600 text-white'
                  : isCurrent
                    ? 'border-2 border-purple-500 text-purple-400 bg-purple-500/10'
                    : 'border border-neutral-700 text-neutral-500'
              }`}>
                {isCompleted ? (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  i + 1
                )}
              </div>
              <span className={`text-xs font-medium transition-colors duration-300 ${
                isActive ? 'text-white' : 'text-neutral-500'
              }`}>
                {step.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Log Messages ────────────────────────────────────────────────────

function LogMessages({ messages }) {
  const containerRef = useRef(null);
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div
      ref={containerRef}
      className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 max-w-md mx-auto mt-6 max-h-48 overflow-y-auto scrollbar-hide"
      style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
    >
      {messages.map((msg, i) => (
        <div
          key={i}
          className={`flex items-start gap-2 text-sm ${i > 0 ? 'mt-2' : ''} animate-fade-in`}
        >
          <span className={`mt-0.5 ${
            msg.type === 'done'
              ? 'text-green-400'
              : msg.type === 'error'
                ? 'text-red-400'
                : 'text-purple-400'
          }`}>
            {msg.type === 'done' ? '✓' : msg.type === 'error' ? '✗' : '→'}
          </span>
          <span className={
            msg.type === 'done'
              ? 'text-green-300 font-medium'
              : msg.type === 'error'
                ? 'text-red-300'
                : 'text-neutral-300'
          }>
            {msg.text}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Complementary Product Card ──────────────────────────────────────

function ComplementaryCard({ product }) {
  const vendor = product.vendor || product.title.split(' ').slice(0, 2).join(' ');
  const name = product.vendor
    ? product.title.replace(new RegExp(`^${product.vendor}\\s*`, 'i'), '')
    : product.title;

  return (
    <div className="group flex-shrink-0 text-center">
      <div className="bg-white aspect-square w-36 sm:w-44 lg:w-full flex items-center justify-center p-3">
        {product.image ? (
          <img
            src={product.image}
            alt={product.title}
            className="max-w-full max-h-full object-contain group-hover:scale-105 transition-transform duration-500"
          />
        ) : (
          <div className="text-neutral-300 text-xs">No image</div>
        )}
      </div>
      <div className="mt-3 w-36 sm:w-44 lg:w-full">
        <p className="text-xs font-bold text-neutral-900 uppercase tracking-wide truncate">
          {vendor}
        </p>
        <p className="text-xs text-neutral-500 mt-0.5 truncate">
          {name}
        </p>
        <p className="text-xs text-neutral-700 font-medium mt-1">
          ${product.price}
        </p>
      </div>
    </div>
  );
}

// ─── Results View ────────────────────────────────────────────────────

function ResultsView({ data }) {
  const { store, outfit } = data;

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <div className="border-b border-neutral-100 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => window.location.href = '/demo'}
            className="text-neutral-400 hover:text-neutral-600 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
            </svg>
          </button>
          <a href="/demo" className="text-base font-light italic tracking-tight text-neutral-900 hover:text-neutral-600 transition-colors">
            Runa
          </a>
        </div>
        <div className="flex items-center gap-2 text-sm text-neutral-500">
          <span className="text-neutral-900">✦</span>
          Styling <span className="font-semibold text-neutral-900">{store.name}</span>
        </div>
      </div>

      {/* Demo Preview Banner */}
      <div className="bg-neutral-950 pt-14 pb-10 text-center px-6">
        <span className="inline-block px-4 py-1.5 rounded-full bg-white/10 text-neutral-300 text-xs font-semibold uppercase tracking-wider mb-6">
          Demo Preview
        </span>
        <h1 className="text-3xl sm:text-4xl font-bold text-white mb-3">
          Here's how <em className="not-italic font-light">Runa</em> would style{' '}
          <span className="text-white/70">{store.name}</span>
        </h1>
        <p className="text-neutral-400 max-w-lg mx-auto text-sm sm:text-base">
          This is a quick preview using a sample of your products.
          Hire Runa to unlock styling across your entire catalog —
          with more outfits, better matching, and real-time updates.
        </p>
        <div className="flex items-center justify-center gap-4 mt-8">
          <a
            href={RUNA_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="px-6 py-3 bg-white text-neutral-900 text-sm font-semibold rounded-full hover:bg-neutral-100 transition-colors"
          >
            Hire Runa
          </a>
          <a
            href={RUNA_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="px-6 py-3 border border-neutral-600 text-neutral-300 text-sm font-semibold rounded-full hover:bg-white/5 transition-colors"
          >
            Live Demo with an Expert
          </a>
        </div>
      </div>

      {/* Product Demo Section */}
      <div className="max-w-4xl mx-auto px-6 py-12 pb-28">
        {/* Simulated PDP */}
        <div className="border border-neutral-200 rounded-2xl overflow-hidden shadow-soft">
          {/* Browser chrome */}
          <div className="bg-neutral-100 px-4 py-3 flex items-center gap-2 border-b border-neutral-200">
            <div className="flex gap-1.5">
              <div className="w-3 h-3 rounded-full bg-red-400" />
              <div className="w-3 h-3 rounded-full bg-yellow-400" />
              <div className="w-3 h-3 rounded-full bg-green-400" />
            </div>
            <div className="ml-3 flex-1 bg-white rounded-md px-3 py-1 text-xs text-neutral-400 truncate">
              {store.domain}/products/{outfit.anchor?.handle || '...'}
            </div>
          </div>

          <div className="p-6 sm:p-8">
            {/* Store name */}
            <p className="text-xs font-medium text-neutral-400 uppercase tracking-widest mb-2">
              {store.name}
            </p>

            {/* Anchor product */}
            <div className="flex flex-col sm:flex-row gap-6">
              <div className="sm:w-1/2">
                <div className="bg-neutral-100 rounded-lg overflow-hidden aspect-[3/4]">
                  {outfit.anchor?.image && (
                    <img
                      src={outfit.anchor.image}
                      alt={outfit.anchor.title}
                      className="w-full h-full object-cover"
                    />
                  )}
                </div>
              </div>
              <div className="sm:w-1/2 flex flex-col justify-center">
                <h2 className="text-xl font-semibold text-neutral-900">
                  {outfit.anchor?.title}
                </h2>
                <p className="text-lg font-medium text-neutral-700 mt-2">
                  ${outfit.anchor?.price}
                </p>
                <div className="mt-6 space-y-3">
                  <button className="w-full py-3 bg-neutral-900 text-white text-sm font-semibold rounded-lg hover:bg-neutral-800 transition-colors">
                    Add to Cart
                  </button>
                  <button className="w-full py-3 border border-neutral-300 text-neutral-700 text-sm font-semibold rounded-lg hover:bg-neutral-50 transition-colors">
                    Buy it Now
                  </button>
                </div>
              </div>
            </div>

            {/* Complete the Look */}
            <div className="mt-10 pt-8 border-t border-neutral-200">
              {/* Desktop layout: anchor image left + items right */}
              <div className="hidden lg:flex lg:gap-8">
                <div className="w-[220px] flex-shrink-0">
                  <div className="bg-white aspect-[3/4] flex items-center justify-center p-2">
                    {outfit.anchor?.image && (
                      <img
                        src={outfit.anchor.image}
                        alt={outfit.anchor.title}
                        className="max-w-full max-h-full object-contain"
                      />
                    )}
                  </div>
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-bold text-neutral-900 uppercase tracking-wide">
                    Complete the Look
                  </h3>
                  <div className="mt-3 mb-5 border-t-2 border-neutral-900" />
                  <div className={`grid gap-5 ${
                    outfit.items?.length <= 2 ? 'grid-cols-2' :
                    outfit.items?.length === 3 ? 'grid-cols-3' :
                    'grid-cols-4'
                  }`}>
                    {outfit.items?.map((item) => (
                      <ComplementaryCard key={item.id} product={item} />
                    ))}
                  </div>
                </div>
              </div>

              {/* Mobile layout: title + horizontal scroll */}
              <div className="lg:hidden">
                <div className="flex items-center gap-5 mb-6">
                  <div className="w-16 h-16 flex-shrink-0 bg-neutral-50 rounded-md flex items-center justify-center overflow-hidden">
                    {outfit.anchor?.image && (
                      <img
                        src={outfit.anchor.image}
                        alt={outfit.anchor.title}
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-neutral-900 uppercase tracking-wide leading-tight">
                      Complete the Look
                    </h3>
                    <p className="text-xs text-neutral-400 mt-0.5">
                      Pairs well with this {outfit.anchor?.vendor || store.name} piece
                    </p>
                  </div>
                </div>
                <div className="flex gap-4 overflow-x-auto pb-4 snap-x">
                  {outfit.items?.map((item) => (
                    <div key={item.id} className="snap-start">
                      <ComplementaryCard product={item} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>

      {/* Bottom CTA */}
      <div className="fixed bottom-0 inset-x-0 bg-neutral-950 border-t border-neutral-800 text-white px-6 py-4 flex items-center justify-between z-50">
        <p className="text-sm text-neutral-300">
          Like what you see? <em className="not-italic font-light">Runa</em> costs less than an intern, works harder than a department.
        </p>
        <div className="flex items-center gap-3">
          <a
            href={RUNA_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="px-5 py-2 bg-white text-neutral-900 text-sm font-semibold rounded-full hover:bg-neutral-100 transition-colors whitespace-nowrap"
          >
            Hire Runa
          </a>
        </div>
      </div>
    </div>
  );
}

// ─── Main Demo Component ─────────────────────────────────────────────

export default function Demo() {
  const { domain: urlDomain } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const websiteParam = searchParams.get('website') || searchParams.get('url') || searchParams.get('store');
  const [inputUrl, setInputUrl] = useState('');
  const [phase, setPhase] = useState('landing'); // landing | loading | results | error
  const [currentStep, setCurrentStep] = useState('scan');
  const [completedSteps, setCompletedSteps] = useState(new Set());
  const [messages, setMessages] = useState([]);
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const eventSourceRef = useRef(null);

  const addMessage = useCallback((text, type = 'info') => {
    setMessages(prev => [...prev, { text, type }]);
  }, []);

  const startAnalysis = useCallback((domain) => {
    setPhase('loading');
    setCurrentStep('scan');
    setCompletedSteps(new Set());
    setMessages([]);
    setResult(null);
    setErrorMsg('');

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const encoded = encodeURIComponent(domain);
    const es = new EventSource(`${API_URL}/demo/analyze?url=${encoded}`);
    eventSourceRef.current = es;

    es.addEventListener('status', (e) => {
      const data = JSON.parse(e.data);
      const stepIdx = getStepIndex(data.step);
      const currentIdx = getStepIndex(currentStep);

      if (stepIdx > currentIdx) {
        setCompletedSteps(prev => {
          const next = new Set(prev);
          STEPS.slice(0, stepIdx).forEach(s => next.add(s.key));
          return next;
        });
      }
      setCurrentStep(data.step);
      addMessage(data.message, 'info');

      if (data.productCount) {
        addMessage(`Found ${data.productCount} products`, 'done');
      }
    });

    es.addEventListener('complete', (e) => {
      const data = JSON.parse(e.data);
      setCompletedSteps(new Set(STEPS.map(s => s.key)));
      addMessage('Your outfit is ready!', 'done');
      setResult(data);

      setTimeout(() => setPhase('results'), 1200);
      es.close();
    });

    es.addEventListener('error', (e) => {
      try {
        const data = JSON.parse(e.data);
        addMessage(data.message, 'error');
        setErrorMsg(data.message);
      } catch {
        addMessage('Connection lost. Please try again.', 'error');
        setErrorMsg('Connection lost. Please try again.');
      }
      setPhase('error');
      es.close();
    });

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) return;
      addMessage('Connection lost. Please try again.', 'error');
      setPhase('error');
      es.close();
    };
  }, [addMessage]);

  // Auto-start if domain is in URL path or query param
  useEffect(() => {
    const domain = urlDomain || websiteParam;
    if (domain) {
      setInputUrl(domain);
      startAnalysis(domain);
    }
  }, [urlDomain, websiteParam, startAnalysis]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  function handleSubmit(e) {
    e.preventDefault();
    const domain = inputUrl.trim();
    if (!domain) return;
    navigate(`/demo/${encodeURIComponent(domain)}`, { replace: true });
    startAnalysis(domain);
  }

  // ─── Results phase ─────────────────────────────────────────────────

  if (phase === 'results' && result) {
    return <ResultsView data={result} />;
  }

  // ─── Landing / Loading / Error ─────────────────────────────────────

  return (
    <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center px-6">
      {phase === 'landing' && (
        <div className="text-center max-w-2xl animate-fade-in">
          <a href={RUNA_URL} target="_blank" rel="noopener noreferrer" className="inline-block text-2xl font-light italic text-white/60 hover:text-white/80 transition-colors mb-10 tracking-tight">
            Runa
          </a>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-4">
            Ready to see your store styled by AI?
          </h1>
          <p className="text-neutral-400 text-lg mb-10">
            Paste your Shopify URL. See results in 60 seconds.
          </p>

          <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 max-w-xl mx-auto">
            <input
              type="text"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              placeholder="runwayher.com or yourstore.myshopify.com"
              className="flex-1 px-5 py-4 rounded-xl bg-neutral-900 border border-neutral-800 text-white text-sm placeholder-neutral-500 focus:outline-none focus:border-neutral-600 transition-colors"
              autoFocus
            />
            <button
              type="submit"
              className="px-6 py-4 bg-white text-neutral-900 text-sm font-semibold rounded-xl hover:bg-neutral-100 transition-all flex items-center justify-center gap-2 whitespace-nowrap"
            >
              Style My Products
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </button>
          </form>

          <div className="flex items-center justify-center gap-6 mt-8">
            <a
              href={RUNA_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-neutral-500 text-xs hover:text-neutral-300 transition-colors flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
              </svg>
              Book a 15-min Walkthrough
            </a>
            <a
              href={RUNA_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-neutral-500 text-xs hover:text-neutral-300 transition-colors flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
              Request Access
            </a>
          </div>

          <p className="text-neutral-700 text-xs mt-6">
            The Agentic Merchant for Fashion
          </p>
        </div>
      )}

      {(phase === 'loading' || phase === 'error') && (
        <div className="text-center max-w-lg w-full animate-fade-in">
          <StepIndicator currentStep={currentStep} completedSteps={completedSteps} />

          {/* AI Agent */}
          <div className="flex items-center justify-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-white/10 border border-white/20 flex items-center justify-center">
              <span className="text-white text-lg">✦</span>
            </div>
            <div className="text-left">
              <p className="text-white font-light italic text-base tracking-tight">Runa</p>
              <p className="text-neutral-500 text-xs">
                {phase === 'error' ? 'Analysis failed' : 'Styling your catalog...'}
              </p>
            </div>
          </div>

          <LogMessages messages={messages} />

          {phase === 'error' && (
            <div className="mt-6 space-y-3">
              <p className="text-red-400 text-sm">{errorMsg}</p>
              <button
                onClick={() => {
                  setPhase('landing');
                  setMessages([]);
                  setErrorMsg('');
                }}
                className="px-5 py-2.5 bg-neutral-800 text-white text-sm rounded-lg hover:bg-neutral-700 transition-colors"
              >
                Try another store
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
