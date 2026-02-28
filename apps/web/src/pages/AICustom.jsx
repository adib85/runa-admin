import { useState } from 'react';
import { api } from '../services/api';

export default function AICustom() {
  const [sku, setSku] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);

  const handleSearch = async () => {
    if (!sku.trim()) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await api.post('/ai/product-description', {
        sku: sku.trim()
      });

      const data = response.data;
      setResult(data);

      // Add to history
      setHistory(prev => [
        { sku: sku.trim(), timestamp: new Date(), description: data.description?.substring(0, 100) + '...' },
        ...prev.slice(0, 19) // Keep last 20
      ]);
    } catch (err) {
      setError(err.message || 'Failed to fetch product description');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !loading) {
      handleSearch();
    }
  };

  const handleHistoryClick = (historySku) => {
    setSku(historySku);
  };

  const handleClear = () => {
    setResult(null);
    setError(null);
    setSku('');
  };

  // Parse markdown-like text into basic HTML
  const formatDescription = (text) => {
    if (!text) return '';

    return text
      // Bold text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      // Bullet points
      .replace(/^\* (.*$)/gm, '<li>$1</li>')
      .replace(/^- (.*$)/gm, '<li>$1</li>')
      // Headers
      .replace(/^### (.*$)/gm, '<h4 class="text-sm font-semibold text-neutral-900 mt-4 mb-2">$1</h4>')
      .replace(/^## (.*$)/gm, '<h3 class="text-base font-semibold text-neutral-900 mt-6 mb-2">$1</h3>')
      .replace(/^# (.*$)/gm, '<h2 class="text-lg font-semibold text-neutral-900 mt-6 mb-3">$1</h2>')
      // Wrap consecutive <li> items in <ul>
      .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul class="list-disc list-inside space-y-1 my-2 text-sm text-neutral-700">$1</ul>')
      // Line breaks
      .replace(/\n\n/g, '</p><p class="text-sm text-neutral-700 leading-relaxed mb-3">')
      .replace(/\n/g, '<br/>');
  };

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <h1 className="page-title">AI Custom</h1>
        <p className="page-subtitle">
          Generează descrieri de produs. Introdu codul SKU al produsului și primești automat o descriere elegantă, gata de publicat.
        </p>
      </div>

      {/* Search Section */}
      <section className="mb-8">
        <h2 className="section-title">Product Description Lookup</h2>
        <div className="border border-neutral-100 p-8">
          <div className="max-w-2xl">
            <label className="label">SKU / Model Number</label>
            <div className="flex gap-3">
              <div className="flex-1 relative">
                <input
                  type="text"
                  className="input pr-10"
                  value={sku}
                  onChange={(e) => setSku(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="e.g. A20937-DLC, NK-AIR-MAX-90, SAMSUNG-QN65S95B"
                  disabled={loading}
                />
                {sku && !loading && (
                  <button
                    onClick={handleClear}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
              <button
                onClick={handleSearch}
                disabled={loading || !sku.trim()}
                className="btn btn-primary flex items-center gap-2 min-w-[140px] justify-center"
              >
                {loading ? (
                  <>
                    <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Searching...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    Search
                  </>
                )}
              </button>
            </div>
            <p className="text-xs text-neutral-400 mt-2">
              Introdu codul produsului și vei primi o descriere completă cu caracteristici, compoziție și dimensiuni.
            </p>
          </div>
        </div>
      </section>

      {/* Loading State */}
      {loading && (
        <section className="mb-8">
          <div className="border border-neutral-100 p-12 text-center">
            <div className="inline-flex items-center gap-3 text-neutral-500">
              <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <div>
                <p className="text-sm font-medium">Se generează descrierea pentru "{sku}"</p>
                <p className="text-xs text-neutral-400 mt-1">Căutăm informații despre produs și pregătim descrierea...</p>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Error State */}
      {error && (
        <section className="mb-8">
          <div className="border border-red-200 bg-red-50 p-6">
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <p className="text-sm font-medium text-red-800">Search Failed</p>
                <p className="text-sm text-red-600 mt-1">{error}</p>
                <button
                  onClick={handleSearch}
                  className="text-sm text-red-700 underline mt-2 hover:text-red-900"
                >
                  Try again
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Result Section */}
      {result && (
        <section className="mb-8 space-y-6">
          {/* Warning if not grounded */}
          {result.warning && (
            <div className="border border-orange-200 bg-orange-50 p-4 flex items-start gap-3">
              <svg className="w-5 h-5 text-orange-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <div>
                <p className="text-sm font-medium text-orange-800">Rezultat neverificat</p>
                <p className="text-xs text-orange-600 mt-1">{result.warning}</p>
                <button
                  onClick={handleSearch}
                  className="text-xs text-orange-700 underline mt-2 hover:text-orange-900 font-medium"
                >
                  Reîncearcă căutarea
                </button>
              </div>
            </div>
          )}

          {/* Grounding badge */}
          {result.grounded && (
            <div className="flex items-center gap-2 text-xs text-green-600">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Verified via Google Search ({result.attempts > 1 ? `${result.attempts} attempts` : '1st attempt'} — {result.sources?.length || 0} sources)
            </div>
          )}

          {/* Product Description */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="section-title mb-0">Result for SKU: {result.sku}</h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(result.description);
                  }}
                  className="btn btn-secondary btn-sm flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                  </svg>
                  Copy
                </button>
                <button
                  onClick={() => alert('Available soon')}
                  className="btn btn-secondary btn-sm flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                  </svg>
                  Save to TOFF
                </button>
              </div>
            </div>
            <div className="border border-neutral-100 p-8">
              <div
                className="prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{
                  __html: `<p class="text-sm text-neutral-700 leading-relaxed mb-3">${formatDescription(result.description)}</p>`
                }}
              />
            </div>
          </div>

          {/* Sources */}
          {result.sources && result.sources.length > 0 && (
            <div>
              <h2 className="section-title">Sources</h2>
              <div className="border border-neutral-100 p-6">
                <div className="space-y-3">
                  {result.sources.map((source, index) => (
                    <a
                      key={index}
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-3 text-sm text-neutral-600 hover:text-neutral-900 transition-colors group"
                    >
                      <span className="w-6 h-6 rounded-full bg-neutral-100 flex items-center justify-center text-xs font-medium text-neutral-500 flex-shrink-0">
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="font-medium group-hover:underline truncate">{source.title}</p>
                        <p className="text-xs text-neutral-400 truncate">{source.url}</p>
                      </div>
                      <svg className="w-4 h-4 text-neutral-300 flex-shrink-0 ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </a>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Search Queries Used */}
          {result.searchQueries && result.searchQueries.length > 0 && (
            <div>
              <h2 className="section-title">Search Queries Used</h2>
              <div className="border border-neutral-100 p-6">
                <div className="flex flex-wrap gap-2">
                  {result.searchQueries.map((query, index) => (
                    <span
                      key={index}
                      className="px-3 py-1.5 bg-neutral-50 text-xs text-neutral-600 rounded-sm border border-neutral-100"
                    >
                      {query}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Search History */}
      {history.length > 0 && (
        <section className="mb-8">
          <h2 className="section-title">Recent Searches</h2>
          <div className="border border-neutral-100">
            <div className="divide-y divide-neutral-50">
              {history.map((item, index) => (
                <button
                  key={index}
                  onClick={() => handleHistoryClick(item.sku)}
                  className="w-full flex items-center justify-between px-6 py-4 hover:bg-neutral-50 transition-colors text-left"
                >
                  <div>
                    <p className="text-sm font-medium text-neutral-900">{item.sku}</p>
                    <p className="text-xs text-neutral-400 mt-0.5">
                      {item.timestamp.toLocaleTimeString()} - {item.description}
                    </p>
                  </div>
                  <svg className="w-4 h-4 text-neutral-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
