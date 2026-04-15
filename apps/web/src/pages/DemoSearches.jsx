import { useState, useEffect } from 'react';
import DemoNav from '../components/DemoNav';

function OutfitPreview({ outfit, onClose }) {
  if (!outfit) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content max-w-2xl max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-sm font-medium text-neutral-900">Outfit Result</h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600 text-lg">&times;</button>
        </div>

        {/* Anchor */}
        <div className="flex gap-4 mb-6">
          {outfit.anchor?.image && (
            <img src={outfit.anchor.image} alt={outfit.anchor.title} className="w-24 h-32 object-cover rounded bg-neutral-100" />
          )}
          <div>
            <p className="text-xs text-neutral-500 uppercase tracking-wide">Anchor Product</p>
            <p className="text-sm font-medium text-neutral-900 mt-1">{outfit.anchor?.title}</p>
            <p className="text-sm text-neutral-600">${outfit.anchor?.price}</p>
          </div>
        </div>

        <div className="divider mb-4" />

        {/* Complementary */}
        <p className="text-xs text-neutral-500 uppercase tracking-wide mb-3">Complete the Look</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {outfit.items?.map((item, i) => (
            <div key={i} className="text-center">
              {item.image && (
                <img src={item.image} alt={item.title} className="w-full aspect-square object-contain bg-neutral-50 rounded mb-2" />
              )}
              <p className="text-xs font-medium text-neutral-900 truncate">{item.title}</p>
              <p className="text-xs text-neutral-500">${item.price}</p>
            </div>
          ))}
        </div>

        {outfit.total_price && (
          <p className="text-sm text-neutral-500 mt-4 pt-4 border-t border-neutral-100 text-right">
            Total: <span className="font-medium text-neutral-900">${outfit.total_price}</span>
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
  const [previewOutfit, setPreviewOutfit] = useState(null);

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
          </p>
        </div>
        {data.cached > 0 && (
          <button
            onClick={async () => {
              if (!confirm('Delete ALL cached results? Next visits will run fresh.')) return;
              await fetch('/api/demo/cache', { method: 'DELETE' });
              window.location.reload();
            }}
            className="px-4 py-2 text-xs font-medium text-red-600 border border-red-200 rounded-md hover:bg-red-50 transition-colors"
          >
            Clear All Cache
          </button>
        )}
      </div>

      <div className="space-y-4">
        {data.stores?.map((store) => {
          const outfit = data.outfitsByDomain?.[store.domain];
          return (
            <div key={store.domain} className="bg-white border border-neutral-100 rounded-lg overflow-hidden hover:border-neutral-200 transition-colors">
              <div className="px-6 py-5 flex items-center justify-between">
                <div className="flex items-center gap-5">
                  {outfit?.anchor?.image ? (
                    <img
                      src={outfit.anchor.image}
                      alt={outfit.anchor.title}
                      className="w-14 h-14 object-cover rounded-md bg-neutral-50"
                    />
                  ) : (
                    <div className="w-14 h-14 rounded-md bg-neutral-50 flex items-center justify-center text-neutral-300 text-xs">—</div>
                  )}
                  <div>
                    <p className="text-sm font-semibold text-neutral-900">{store.storeName || store.domain}</p>
                    <p className="text-xs text-neutral-400 mt-1">
                      {store.domain} · {store.totalVisits} visits
                      {store.cachedHits > 0 && <span className="text-purple-500 ml-1">({store.cachedHits} cached)</span>}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {outfit ? (
                    <>
                      <button
                        onClick={() => setPreviewOutfit(outfit)}
                        className="px-4 py-2 text-xs font-medium text-neutral-700 border border-neutral-200 rounded-md hover:bg-neutral-50 transition-colors whitespace-nowrap"
                      >
                        View
                      </button>
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
                    </>
                  ) : (
                    <span className="text-xs text-neutral-300">No result</span>
                  )}
                </div>
              </div>
              {/* Visit history */}
              {store.visits.length > 0 && (
                <div className="border-t border-neutral-50 px-6 py-3 bg-neutral-50/50">
                  <div className="flex flex-wrap gap-x-6 gap-y-1">
                    {store.visits.map((v, i) => (
                      <span key={i} className="text-xs text-neutral-400">
                        {new Date(v.time).toLocaleString()}
                        {v.fromCache && <span className="text-purple-400 ml-1">·cache</span>}
                        {v.ip && v.ip !== 'unknown' && <span className="text-neutral-300 ml-1">·{v.ip}</span>}
                      </span>
                    ))}
                    {store.totalVisits > 10 && (
                      <span className="text-xs text-neutral-300">+{store.totalVisits - 10} more</span>
                    )}
                  </div>
                </div>
              )}
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
