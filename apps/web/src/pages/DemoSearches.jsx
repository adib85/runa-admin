import { useState, useEffect } from 'react';
import DemoNav from '../components/DemoNav';
import { formatPrice } from '../utils/formatPrice';

function formatUSD(value) {
  if (value == null || !Number.isFinite(Number(value))) return '';
  const n = Number(value);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `$${n.toFixed(0)}`;
}

function isLocalIp(ip) {
  if (!ip) return true;
  const v = String(ip).replace(/^::ffff:/, '');
  if (v === 'unknown' || v === '::1' || v === 'localhost') return true;
  if (v.startsWith('127.')) return true;
  if (v.startsWith('10.')) return true;
  if (v.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(v)) return true;
  return false;
}

function OutfitPreview({ outfit, onClose }) {
  if (!outfit) return null;
  const currency = outfit.currency || 'USD';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content max-w-2xl max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-sm font-medium text-neutral-900">Outfit Result</h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600 text-lg">&times;</button>
        </div>

        <div className="flex gap-4 mb-6">
          {outfit.anchor?.image && (
            <img src={outfit.anchor.image} alt={outfit.anchor.title} className="w-24 h-32 object-cover rounded bg-neutral-100" />
          )}
          <div>
            <p className="text-xs text-neutral-500 uppercase tracking-wide">Anchor Product</p>
            <p className="text-sm font-medium text-neutral-900 mt-1">{outfit.anchor?.title}</p>
            <p className="text-sm text-neutral-600">{formatPrice(outfit.anchor?.price, currency)}</p>
          </div>
        </div>

        <div className="divider mb-4" />

        <p className="text-xs text-neutral-500 uppercase tracking-wide mb-3">Complete the Look</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {outfit.items?.map((item, i) => (
            <div key={i} className="text-center">
              {item.image && (
                <img src={item.image} alt={item.title} className="w-full aspect-square object-contain bg-neutral-50 rounded mb-2" />
              )}
              <p className="text-xs font-medium text-neutral-900 truncate">{item.title}</p>
              <p className="text-xs text-neutral-500">{formatPrice(item.price, currency)}</p>
            </div>
          ))}
        </div>

        {outfit.total_price && (
          <p className="text-sm text-neutral-500 mt-4 pt-4 border-t border-neutral-100 text-right">
            Total: <span className="font-medium text-neutral-900">{formatPrice(outfit.total_price, currency)}</span>
          </p>
        )}
      </div>
    </div>
  );
}

export default function DemoSearches() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedVisits, setExpandedVisits] = useState({});
  const [previewOutfit, setPreviewOutfit] = useState(null);

  const toggleVisits = (domain) => {
    setExpandedVisits(prev => ({ ...prev, [domain]: !prev[domain] }));
  };

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/demo/searches');
        if (!res.ok) throw new Error('Failed to fetch');
        setData(await res.json());
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="spinner" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50">
        <div className="text-center max-w-sm">
          <p className="text-sm font-medium text-neutral-900 mb-2">Unable to load demo searches</p>
          <p className="text-xs text-neutral-500 mb-6">{error}</p>
          <p className="text-xs text-neutral-400">Check that AWS credentials and DynamoDB CacheTable are configured.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <DemoNav />
      <div className="max-w-3xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between mb-10">
        <div>
          <h1 className="text-2xl font-light tracking-tight text-neutral-900">Searches</h1>
          <p className="text-sm text-neutral-500 mt-2">
            {data.totalStores} stores · {data.totalSearches} total visits · {data.cached} cached
            {(() => {
              const hot = (data.stores || []).filter(s => (s.externalVisits || 0) >= 2).length;
              return hot > 0 ? (
                <span
                  className="text-amber-600 font-medium ml-1"
                  title="Stores with 2+ real external visits (Romania, localhost and unresolved IPs excluded)"
                >
                  · 🔥 {hot} hot lead{hot === 1 ? '' : 's'}
                </span>
              ) : null;
            })()}
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {data.stores?.map((store) => {
          const outfit = data.outfitsByDomain?.[store.domain];
          const isHotLead = (store.externalVisits || 0) >= 2;
          return (
            <div
              key={store.domain}
              className={`rounded-lg overflow-hidden transition-colors ${
                isHotLead
                  ? 'bg-amber-50/40 border-2 border-amber-300 hover:border-amber-400 shadow-sm'
                  : 'bg-white border border-neutral-100 hover:border-neutral-200'
              }`}
            >
              <div className="px-4 sm:px-6 py-4 sm:py-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="flex items-start gap-3 sm:gap-5 min-w-0 flex-1">
                  {outfit?.anchor?.image ? (
                    <img
                      src={outfit.anchor.image}
                      alt={outfit.anchor.title}
                      className="w-12 h-12 sm:w-14 sm:h-14 object-cover rounded-md bg-neutral-50 flex-shrink-0"
                    />
                  ) : (
                    <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-md bg-neutral-50 flex items-center justify-center text-neutral-300 text-xs flex-shrink-0">—</div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-neutral-900 truncate min-w-0">
                        {store.storeName || store.domain}
                      </p>
                      {isHotLead && (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-amber-200 text-amber-900 whitespace-nowrap flex-shrink-0"
                          title={`${store.externalVisits} visits${store.uniqueExternalCountries > 1 ? ` from ${store.uniqueExternalCountries} different countries` : ''}. Romania, localhost and unresolved IPs are excluded as internal test traffic.`}
                        >
                          🔥 {store.externalVisits} visits
                          {store.uniqueExternalCountries > 1 && ` · ${store.uniqueExternalCountries} countries`}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-neutral-400 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <a
                        href={`https://${store.domain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-purple-500 hover:text-purple-700 truncate max-w-full"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {store.domain}
                      </a>
                      <span className="text-neutral-300">·</span>
                      <a
                        href={`/demo?website=${encodeURIComponent(store.domain)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-purple-500 hover:text-purple-700 hover:underline whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                      >
                        open demo
                      </a>
                      {outfit && (
                        <>
                          <span className="text-neutral-300">·</span>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setPreviewOutfit(outfit); }}
                            className="text-purple-500 hover:text-purple-700 whitespace-nowrap"
                          >
                            quick view
                          </button>
                        </>
                      )}
                      <span className="text-neutral-300">·</span>
                      <span className="whitespace-nowrap">{store.totalVisits} visits</span>
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 sm:gap-3 self-end sm:self-auto flex-shrink-0">
                  {outfit ? (
                    <button
                      onClick={async () => {
                        if (!confirm(`Delete cached result for ${store.domain}?`)) return;
                        await fetch(`/api/demo/cache/${store.domain}`, { method: 'DELETE' });
                        window.location.reload();
                      }}
                      className="px-3 py-2 text-xs text-red-500 hover:bg-red-50 rounded-md transition-colors whitespace-nowrap"
                    >
                      Delete
                    </button>
                  ) : (
                    <span className="text-xs text-neutral-300">No result</span>
                  )}
                </div>
              </div>
              {/* Lead / contact info from LeadsCompanyTable */}
              {store.lead && (store.lead.ownerName || store.lead.email || store.lead.linkedin || store.lead.brandTier || store.lead.annualRevenue) && (
                <div className="border-t border-neutral-50 px-6 py-3 bg-white">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    {store.lead.brandTier && (
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide ${
                        store.lead.brandTier === 'luxury' ? 'bg-amber-50 text-amber-700' :
                        store.lead.brandTier === 'premium' ? 'bg-indigo-50 text-indigo-700' :
                        store.lead.brandTier === 'mid' ? 'bg-emerald-50 text-emerald-700' :
                        'bg-neutral-100 text-neutral-600'
                      }`}>
                        {store.lead.brandTier}
                      </span>
                    )}
                    {store.lead.country && (
                      <span className="text-neutral-400">{store.lead.country}</span>
                    )}
                    {store.lead.annualRevenue != null && (
                      <span
                        className="text-emerald-700 font-medium"
                        title={`Monthly: ${formatUSD(store.lead.monthlyRevenue)} · Annual = monthly × 12`}
                      >
                        {formatUSD(store.lead.annualRevenue)}/yr
                      </span>
                    )}
                    {store.lead.ownerName && (
                      <span className="text-neutral-700 font-medium">
                        {store.lead.ownerName}
                        {store.lead.ownerTitle && (
                          <span className="text-neutral-400 font-normal"> · {store.lead.ownerTitle}</span>
                        )}
                      </span>
                    )}
                    {store.lead.email && (
                      <a
                        href={`mailto:${store.lead.email}`}
                        className="text-blue-600 hover:text-blue-800 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {store.lead.email}
                      </a>
                    )}
                    {store.lead.linkedin && (
                      <a
                        href={store.lead.linkedin.startsWith('http') ? store.lead.linkedin : `https://${store.lead.linkedin}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#0077b5] hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        LinkedIn
                      </a>
                    )}
                    {store.lead.source && (
                      <span className="text-neutral-300">via {store.lead.source}</span>
                    )}
                    {store.lead.outreachStatus && store.lead.outreachStatus !== 'pending' && (
                      <span className="ml-auto px-2 py-0.5 rounded-full text-[10px] bg-neutral-100 text-neutral-600">
                        {store.lead.outreachStatus}
                      </span>
                    )}
                  </div>
                  {store.lead.personalizationMessage && (
                    <p className="text-xs text-neutral-500 mt-2 italic line-clamp-2">
                      {store.lead.personalizationMessage}
                    </p>
                  )}
                </div>
              )}
              {/* Visit history */}
              {store.visits.length > 0 && (() => {
                const COLLAPSED_COUNT = 3;
                const isExpanded = !!expandedVisits[store.domain];
                const visibleVisits = isExpanded ? store.visits : store.visits.slice(0, COLLAPSED_COUNT);
                const hiddenInList = Math.max(0, store.visits.length - COLLAPSED_COUNT);
                const overflowBeyondList = Math.max(0, store.totalVisits - store.visits.length);
                return (
                  <div className="border-t border-neutral-50 px-4 sm:px-6 py-3 bg-neutral-50/50">
                    <div className="flex flex-wrap gap-x-6 gap-y-1">
                      {visibleVisits.map((v, i) => {
                        const localIp = isLocalIp(v.ip);
                        const isInternal = localIp || !v.country || v.country === 'Romania';
                        const reason = localIp
                          ? `localhost / private IP (${v.ip}) — internal test`
                          : !v.country
                          ? 'no geo resolved (likely internal test)'
                          : 'visit from Romania (internal test)';
                        return (
                          <span
                            key={i}
                            className={`text-xs ${isInternal ? 'text-neutral-300 line-through decoration-neutral-300' : 'text-neutral-500'}`}
                            title={isInternal ? `${reason} — excluded from visit count` : 'External visit'}
                          >
                            {new Date(v.time).toLocaleString()}
                            {v.fromCache && <span className="text-purple-400 ml-1 no-underline">·cache</span>}
                            {v.city && <span className="ml-1">·{v.city}, {v.country}</span>}
                            {!v.city && v.ip && v.ip !== 'unknown' && <span className="text-neutral-300 ml-1">·{v.ip}</span>}
                          </span>
                        );
                      })}
                    </div>
                    {(hiddenInList > 0 || overflowBeyondList > 0) && (
                      <div className="mt-2">
                        {hiddenInList > 0 && (
                          <button
                            onClick={() => toggleVisits(store.domain)}
                            className="text-xs font-medium text-neutral-500 hover:text-neutral-900 hover:underline"
                          >
                            {isExpanded
                              ? 'Show less'
                              : `View all ${store.visits.length} visits${overflowBeyondList > 0 ? ` (+${overflowBeyondList} older)` : ''}`}
                          </button>
                        )}
                        {hiddenInList === 0 && overflowBeyondList > 0 && (
                          <span className="text-xs text-neutral-300">+{overflowBeyondList} older visits not stored</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        })}
        {(!data.stores || data.stores.length === 0) && (
          <div className="text-center py-20">
            <p className="text-sm font-medium text-neutral-900 mb-1">No searches yet</p>
            <p className="text-sm text-neutral-500">
              Run a demo at <a href="/demo" className="link">/demo</a> to see results here
            </p>
          </div>
        )}
      </div>

      {previewOutfit && (
        <OutfitPreview outfit={previewOutfit} onClose={() => setPreviewOutfit(null)} />
      )}
      </div>
    </div>
  );
}
