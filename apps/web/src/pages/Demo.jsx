import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { formatPrice } from '../utils/formatPrice';

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

function ComplementaryCard({ product, currency }) {
  const vendor = product.vendor || '';
  const name = vendor
    ? product.title.replace(new RegExp(`^${vendor}\\s*`, 'i'), '') || product.title
    : product.title;

  return (
    <div className="group flex-shrink-0 text-center min-w-[130px] w-[130px] sm:w-44 lg:w-full">
      <div className="bg-white aspect-square w-full flex items-center justify-center">
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
      <div className="mt-3 w-full">
        {vendor && (
          <p className="text-xs font-bold text-neutral-900 uppercase tracking-wide truncate">
            {vendor}
          </p>
        )}
        <p className="text-xs text-neutral-500 mt-0.5 line-clamp-2">
          {name}
        </p>
        <p className="text-xs text-neutral-700 font-medium mt-1">
          {formatPrice(product.price, currency)}
        </p>
      </div>
    </div>
  );
}

// ─── Results View ────────────────────────────────────────────────────

function ResultsView({ data, setResult }) {
  const { store, outfit, alternativeOutfits = [], debug } = data;

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <div className="bg-neutral-950 border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => window.location.href = '/demo'}
            className="text-neutral-500 hover:text-neutral-300 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
            </svg>
          </button>
          <a href={RUNA_URL} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold tracking-wide text-white/70 hover:text-white transition-colors">
            RUNA
          </a>
        </div>
        <div className="flex items-center gap-2 text-sm text-neutral-400">
          <span className="text-purple-400">✦</span>
          Styling <span className="font-semibold text-white">{store.name}</span>
        </div>
      </div>

      {/* Demo Preview Banner */}
      <div className="bg-neutral-950 pt-8 sm:pt-14 pb-8 sm:pb-12 text-center px-6">
        <span className="inline-block px-3 py-1 rounded-full bg-white/10 text-neutral-300 text-[10px] sm:text-xs font-semibold uppercase tracking-wider mb-4 sm:mb-6">
          Demo Preview
        </span>
        <h1 className="text-xl sm:text-4xl font-bold text-white mb-1 sm:mb-2">
          Here's how Runa would style
        </h1>
        <h2 className="text-2xl sm:text-4xl font-bold text-purple-400 mb-3 sm:mb-5">
          {store.name}
        </h2>
        <p className="text-neutral-400 max-w-md mx-auto text-xs sm:text-base leading-relaxed">
          A quick preview using a sample of your products.
          Install Runa to unlock styling across your entire catalog.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-6">
          <a
            href="https://calendly.com/adrian-askruna/30min"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-3 bg-white text-neutral-900 text-sm font-semibold rounded-full hover:bg-neutral-200 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
            </svg>
            Book a Call
          </a>
          <a
            href={RUNA_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-3 border border-white text-white text-sm font-semibold rounded-full hover:bg-white/10 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
            </svg>
            Explore Runa
          </a>
        </div>
      </div>

      {/* Product Demo Section */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-12 pb-28">
        {/* Simulated PDP */}
        <div id="product-demo" />
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
                  {formatPrice(outfit.anchor?.price, store.currency)}
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
                  <h3 className="text-base font-bold text-neutral-900 uppercase tracking-wide">
                    Complete the Look
                  </h3>
                  <div className="mt-3 mb-5 border-t border-neutral-200" />
                  <div className={`grid gap-5 ${
                    outfit.items?.length >= 4 ? 'grid-cols-4' : 'grid-cols-3'
                  }`}>
                    {outfit.items?.map((item) => (
                      <ComplementaryCard key={item.id} product={item} currency={store.currency} />
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
                      {(() => {
                        const vendors = new Set(outfit.items?.map(i => i.vendor).filter(Boolean));
                        const anchorVendor = outfit.anchor?.vendor;
                        const hasDifferentBrands = vendors.size > 0 && (!anchorVendor || [...vendors].some(v => v !== anchorVendor));
                        return hasDifferentBrands && anchorVendor
                          ? `Pairs well with this ${anchorVendor} piece`
                          : 'Pairs well with this piece';
                      })()}
                    </p>
                  </div>
                </div>
                <div className="flex gap-3 overflow-x-auto pb-4 snap-x">
                  {outfit.items?.map((item) => (
                    <div key={item.id} className="snap-start">
                      <ComplementaryCard product={item} currency={store.currency} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Alternative outfits */}
        {alternativeOutfits.length > 0 && (
          <div className="mt-10 pt-8 border-t border-neutral-100">
            <h3 className="text-base font-bold text-neutral-900 text-center mb-6">Try Another Product</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {alternativeOutfits.map((alt, i) => (
                <div
                  key={i}
                  className="border border-neutral-200 rounded-xl p-4 hover:border-purple-300 cursor-pointer transition-colors"
                  onClick={() => {
                    document.getElementById('product-demo')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    data.outfit = alt;
                    data.alternativeOutfits = [outfit, ...alternativeOutfits.filter((_, j) => j !== i)];
                    setResult({ ...data });
                  }}
                >
                  <div className="flex items-center gap-4">
                    {alt.anchor?.image && (
                      <img src={alt.anchor.image} alt={alt.anchor.title} className="w-20 h-24 object-cover rounded-lg bg-neutral-50" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-neutral-900 truncate">{alt.anchor?.title}</p>
                      <p className="text-xs text-neutral-500 mt-1">{formatPrice(alt.anchor?.price, store.currency)}</p>
                      <div className="flex gap-1.5 mt-2">
                        {alt.items?.slice(0, 4).map((item, j) => (
                          item.image && <img key={j} src={item.image} alt="" className="w-8 h-8 rounded object-cover bg-neutral-100" />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer section */}
        <div className="mt-6 sm:mt-8 mb-4 sm:mb-16 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-purple-50 mb-4">
            <span className="text-purple-500 text-sm">✦</span>
            <span className="text-sm text-purple-700 font-medium">Styled by <em className="italic">Runa</em> AI</span>
          </div>
          <p className="text-sm text-neutral-600 mb-8 max-w-sm mx-auto leading-relaxed">
            This is a preview with default styling. With Runa installed, outfits are tailored to your brand guidelines, visual identity, and merchandising rules.
          </p>

          <p className="text-sm text-neutral-500 mb-6">Average lift from stores running Runa</p>
          <div className="flex items-center justify-center gap-12">
            <div className="text-center">
              <p className="text-xl sm:text-2xl font-bold text-neutral-900 tracking-tight">+15<span className="text-purple-600">%</span></p>
              <p className="text-xs text-neutral-500 mt-1">Conversion Rate</p>
            </div>
            <div className="w-px h-8 sm:h-10 bg-neutral-200" />
            <div className="text-center">
              <p className="text-xl sm:text-2xl font-bold text-neutral-900 tracking-tight">+10<span className="text-purple-600">%</span></p>
              <p className="text-xs text-neutral-500 mt-1">Average Order Value</p>
            </div>
          </div>

        </div>

      </div>

      {/* Debug Panel */}
      {debug && (
        <div className="max-w-4xl mx-auto px-4 sm:px-6 pb-28">
          <div className="mt-8 border border-neutral-200 rounded-xl overflow-hidden">
            <div className="bg-neutral-100 px-5 py-3 flex items-center justify-between">
              <span className="text-xs font-bold text-neutral-600 uppercase tracking-wider">Debug Info</span>
              <span className="text-xs text-neutral-400">{debug.totalTime} · {debug.totalCalls} calls · {debug.totalInputTokens} in / {debug.totalOutputTokens} out</span>
            </div>
            <div className="divide-y divide-neutral-100">
              {debug.calls?.map((call, i) => (
                <div key={i} className="px-5 py-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold text-neutral-900">{call.name}</span>
                    <div className="flex items-center gap-3 text-xs text-neutral-400">
                      <span>{call.elapsed}</span>
                      <span>{call.inputTokens} in / {call.outputTokens} out</span>
                      <span>{call.inputChars} chars</span>
                    </div>
                  </div>
                  {call.rawResponse && (
                    <details>
                      <summary className="text-xs text-neutral-400 cursor-pointer hover:text-neutral-600">Show response</summary>
                      <pre className="mt-2 px-3 py-2 bg-neutral-50 rounded text-xs text-neutral-600 font-mono overflow-x-auto whitespace-pre-wrap">{call.rawResponse}</pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Bottom CTA */}
      <div className="fixed bottom-0 inset-x-0 bg-neutral-950 border-t border-neutral-800 text-white z-50">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <p className="text-sm text-neutral-300 hidden sm:block">
            Like what you see? <em className="not-italic italic font-light">Runa</em> costs less than an intern, works harder than a department.
          </p>
          <p className="text-sm text-neutral-300 sm:hidden">
            Like what you see?
          </p>
          <a
            href="https://calendly.com/adrian-askruna/30min"
            target="_blank"
            rel="noopener noreferrer"
            className="px-5 py-2 bg-white text-neutral-900 text-sm font-semibold rounded-full hover:bg-neutral-100 transition-colors whitespace-nowrap ml-6"
          >
            Book a Call
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
  const skipCaching = searchParams.get('skipCaching') === 'true';
  const debugMode = searchParams.get('debug') === 'true';
  const modelParam = searchParams.get('model') || '';
  const [inputUrl, setInputUrl] = useState('');
  const [phase, setPhase] = useState('landing'); // landing | loading | results | error
  const [currentStep, setCurrentStep] = useState('scan');
  const [completedSteps, setCompletedSteps] = useState(new Set());
  const [messages, setMessages] = useState([]);
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [previewImages, setPreviewImages] = useState([]);
  const [productCount, setProductCount] = useState(0);
  const [collectionStats, setCollectionStats] = useState([]);
  const [stylingMsg, setStylingMsg] = useState(0);
  const [anchorMsg, setAnchorMsg] = useState(0);
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
    setPreviewImages([]);

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const encoded = encodeURIComponent(domain);
    let params = '';
    if (skipCaching) params += '&skipCaching=true';
    if (debugMode) params += '&debug=true';
    if (modelParam) params += `&model=${modelParam}`;
    const es = new EventSource(`${API_URL}/demo/analyze?url=${encoded}${params}`);
    eventSourceRef.current = es;

    es.addEventListener('status', (e) => {
      const data = JSON.parse(e.data);
      const stepIdx = getStepIndex(data.step);

      if (stepIdx >= 0) {
        setCompletedSteps(prev => {
          const next = new Set(prev);
          STEPS.slice(0, stepIdx).forEach(s => next.add(s.key));
          return next;
        });
        setCurrentStep(data.step);
      }
      addMessage(data.message, 'info');

      if (data.productCount) {
        setProductCount(data.productCount);
        addMessage(`Found ${data.productCount} products`, 'done');
      }
      if (data.previewImages) {
        setPreviewImages(data.previewImages);
      }
      if (data.collectionStats) {
        setCollectionStats(data.collectionStats);
      }
    });

    es.addEventListener('complete', (e) => {
      const data = JSON.parse(e.data);
      setCompletedSteps(new Set(['scan', 'classify']));
      setCurrentStep('style');
      setResult(data);
      setPhase('anchor');
      setTimeout(() => setCompletedSteps(new Set(STEPS.map(s => s.key))), 1500);
      setTimeout(() => setPhase('results'), 3000);
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

  const anchorMessages = [
    'Found the perfect anchor',
    'Creating your outfit look...',
  ];

  useEffect(() => {
    if (phase !== 'anchor') return;
    const interval = setInterval(() => {
      setAnchorMsg(prev => Math.min(prev + 1, anchorMessages.length - 1));
    }, 1500);
    return () => clearInterval(interval);
  }, [phase]);

  const stylingMessages = [
    `Classifying ${productCount || ''} products...`,
    'Analyzing color palettes...',
    'Detecting style patterns...',
    'Mapping product categories...',
    'Finding compatible pieces...',
    'Selecting anchor products...',
    'Evaluating outfit combinations...',
    'Matching styles across categories...',
    'Scoring color coordination...',
    'Building complementary sets...',
  ];

  useEffect(() => {
    if (previewImages.length === 0) return;
    const interval = setInterval(() => {
      setStylingMsg(prev => (prev + 1) % stylingMessages.length);
    }, 4000);
    return () => clearInterval(interval);
  }, [previewImages]);

  // Set page title
  useEffect(() => {
    document.title = 'Runa — AI Styling Demo';
    return () => { document.title = 'Runa Admin'; };
  }, []);

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
    return <ResultsView data={result} setResult={setResult} />;
  }

  // ─── Anchor Preview ────────────────────────────────────────────────

  if (phase === 'anchor' && result) {
    const anchor = result.outfit?.anchor;
    return (
      <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center px-6 animate-fade-in">
        {/* Same header as loading */}
        <div className="mb-8">
          <div className="relative w-20 h-20 mx-auto mb-4">
            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-purple-500 border-r-purple-500/30 animate-spin" />
            <div className="absolute inset-1 rounded-full bg-white/5 border border-white/10 flex items-center justify-center">
              <span className="text-white text-2xl font-light italic tracking-tight">R</span>
            </div>
          </div>
          <p className="text-white font-medium text-xl tracking-tight text-center">Runa</p>
          <div className="flex items-center justify-center gap-2 mt-1.5">
            <p className="text-neutral-400 text-sm">
              Styling <span className="text-white font-medium">{inputUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')}</span>
            </p>
          </div>
        </div>

        <StepIndicator currentStep="style" completedSteps={completedSteps} />

        <p className="text-neutral-400 text-sm mb-6 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
          {anchorMessages[anchorMsg]}
        </p>

        {anchor && (
          <div className="border border-white/10 bg-white/5 rounded-2xl p-5 max-w-sm w-full animate-slide-up">
            <div className="flex items-start gap-4">
              {anchor.image && (
                <img src={anchor.image} alt={anchor.title} className="w-20 h-28 object-cover rounded-lg bg-white" />
              )}
              <div className="flex-1 pt-1">
                <p className="text-purple-400 text-xs font-bold uppercase tracking-wider mb-1">Star Product</p>
                <p className="text-white font-semibold text-sm leading-snug">{anchor.title}</p>
                <p className="text-neutral-400 text-sm mt-1.5">{formatPrice(anchor.price, result.store?.currency)}</p>
              </div>
            </div>
          </div>
        )}

      </div>
    );
  }

  // ─── Landing / Loading / Error ─────────────────────────────────────

  return (
    <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center px-6">
      {phase === 'landing' && (
        <div className="text-center max-w-2xl animate-fade-in px-4">
          <a href={RUNA_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-white/50 hover:text-white/70 transition-colors mb-12">
            <span className="text-3xl font-light italic tracking-tight">Runa</span>
          </a>
          <h1 className="text-3xl sm:text-5xl font-bold text-white leading-tight mb-5">
            Ready to see your store styled by AI?
          </h1>
          <p className="text-neutral-400 text-base sm:text-lg mb-10">
            Paste your website URL. See results in 30 seconds.
          </p>

          <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 max-w-md mx-auto">
            <input
              type="text"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              placeholder="runwayher.com"
              className="flex-1 px-5 py-4 rounded-2xl bg-white/5 border border-white/10 text-white text-base sm:text-sm placeholder-neutral-500 focus:outline-none focus:border-white/25 transition-colors"
              autoFocus
            />
            <button
              type="submit"
              className="px-7 py-4 bg-white text-neutral-900 text-sm font-bold rounded-2xl hover:bg-neutral-200 transition-all flex items-center justify-center gap-2 whitespace-nowrap shadow-lg shadow-white/10"
            >
              Style My Products
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </button>
          </form>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-8 mt-10">
            <a
              href="https://calendly.com/adrian-askruna/30min"
              target="_blank"
              rel="noopener noreferrer"
              className="text-neutral-500 text-sm py-2 hover:text-neutral-300 transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
              </svg>
              Book a Call
            </a>
            {/* <a
              href={RUNA_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-neutral-500 text-sm py-2 hover:text-neutral-300 transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
              Install on Shopify
            </a> */}
          </div>

          <p className="text-neutral-700 text-xs mt-8">
            Get started for free · 5-minute setup
          </p>
          <a href={RUNA_URL} target="_blank" rel="noopener noreferrer" className="text-neutral-600 text-xs mt-4 inline-block hover:text-neutral-400 transition-colors">
            askruna.ai
          </a>
        </div>
      )}

      {(phase === 'loading' || phase === 'error') && (
        <div className="text-center max-w-lg w-full animate-fade-in">
          {/* Runa logo with spinning border */}
          <div className="mb-8">
            <div className="relative w-20 h-20 mx-auto mb-4">
              {phase === 'loading' && (
                <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-purple-500 border-r-purple-500/30 animate-spin" />
              )}
              <div className="absolute inset-1 rounded-full bg-white/5 border border-white/10 flex items-center justify-center">
                <span className="text-white text-2xl font-light italic tracking-tight">R</span>
              </div>
            </div>
            <p className="text-white font-medium text-xl tracking-tight">Runa</p>
            <div className="flex items-center justify-center gap-2 mt-1.5">
              <p className="text-neutral-400 text-sm">
                {phase === 'error'
                  ? 'Analysis failed'
                  : <>Styling <span className="text-white font-medium">{inputUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')}</span></>
                }
              </p>
            </div>
          </div>

          {phase !== 'error' && <StepIndicator currentStep={currentStep} completedSteps={completedSteps} />}

          {phase === 'error' ? null : previewImages.length > 0 ? (
            <div className="mt-6 max-w-lg mx-auto animate-fade-in">
              <p className="text-neutral-400 text-sm mb-5 flex items-center justify-center gap-2.5">
                <span className="w-2.5 h-2.5 rounded-full bg-purple-500 animate-pulse" />
                {stylingMessages[stylingMsg]}
              </p>
              <div className="grid grid-cols-6 gap-2">
                {previewImages.slice(0, -1).map((img, i) => (
                  <div
                    key={i}
                    className="aspect-square bg-white rounded overflow-hidden animate-fade-in"
                    style={{ animationDelay: `${i * 50}ms` }}
                  >
                    <img src={img} alt="" className="w-full h-full object-cover" />
                  </div>
                ))}
                {productCount > previewImages.length - 1 && (
                  <div className="aspect-square bg-white/5 rounded flex items-center justify-center animate-fade-in">
                    <span className="text-neutral-400 text-sm font-medium">+{productCount - previewImages.length + 1}</span>
                  </div>
                )}
              </div>

            </div>
          ) : (
            <LogMessages messages={messages} />
          )}

          {phase === 'error' && (
            <div className="mt-6 max-w-sm mx-auto text-center space-y-4">
              <p className="text-neutral-300 text-sm leading-relaxed">{errorMsg}</p>
              <a
                href={RUNA_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block px-5 py-2.5 bg-white text-neutral-900 text-sm font-semibold rounded-full hover:bg-neutral-200 transition-colors"
              >
                Visit askruna.ai
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
