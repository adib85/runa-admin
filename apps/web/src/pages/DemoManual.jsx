import { useState } from 'react';
import DemoNav from '../components/DemoNav';
import { formatPrice } from '../utils/formatPrice';

const PLACEHOLDER = `Outfit 1:
(HERO) https://store.com/products/anchor-handle
https://store.com/products/item-handle
https://store.com/products/item-handle
https://store.com/products/item-handle

Outfit 2:
(HERO) https://store.com/products/another-anchor
https://store.com/products/...
`;

export default function DemoManual() {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function run({ dryRun }) {
    if (!input.trim()) {
      setError('Paste outfit URLs first.');
      return;
    }
    setBusy(true);
    setResult(null);
    setError('');
    try {
      const res = await fetch('/api/demo/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, dryRun }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const outfits = result?.payload
    ? [result.payload.outfit, ...(result.payload.alternativeOutfits || [])]
    : [];
  const currency = result?.payload?.store?.currency || 'USD';

  return (
    <div>
      <DemoNav />
      <div className="max-w-3xl mx-auto px-6 py-12">
        <div className="mb-8">
          <h1 className="text-2xl font-light tracking-tight text-neutral-900">Manual Outfit Seed</h1>
          <p className="text-sm text-neutral-500 mt-2">
            Paste hand-picked outfit URLs below. Gemini parses them, products are
            fetched from Shopify, and the result is written to the demo cache for
            that store. The next visit to the demo for that domain will return
            this curated set instantly.
          </p>
        </div>

        <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-2">
          Input
        </label>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={18}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          className="w-full px-4 py-3 bg-white border border-neutral-200 rounded-lg text-sm text-neutral-800 font-mono leading-relaxed focus:outline-none focus:border-neutral-400 transition-colors resize-y"
        />

        <div className="flex items-center gap-3 mt-4">
          <button
            onClick={() => run({ dryRun: true })}
            disabled={busy}
            className="px-5 py-2.5 bg-white text-neutral-900 border border-neutral-300 text-xs font-semibold uppercase tracking-wider rounded hover:bg-neutral-50 disabled:opacity-50 transition-colors"
          >
            {busy ? 'Working…' : 'Preview (dry-run)'}
          </button>
          <button
            onClick={() => run({ dryRun: false })}
            disabled={busy}
            className="px-5 py-2.5 bg-neutral-900 text-white text-xs font-semibold uppercase tracking-wider rounded hover:bg-neutral-800 disabled:opacity-50 transition-colors"
          >
            {busy ? 'Saving…' : 'Save to Cache'}
          </button>
          {result && !error && (
            <span className="text-sm text-neutral-500">
              {result.dryRun ? 'Preview only — not saved.' : `Saved to cache for ${result.domain}.`}
            </span>
          )}
        </div>

        {error && (
          <div className="mt-6 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
            {error}
          </div>
        )}

        {result?.steps?.length > 0 && (
          <div className="mt-6 px-4 py-3 bg-neutral-50 border border-neutral-200 rounded-lg">
            <p className="text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-2">Steps</p>
            <ul className="text-xs text-neutral-700 space-y-1 font-mono">
              {result.steps.map((s, i) => (
                <li key={i}>{i + 1}. {s}</li>
              ))}
            </ul>
          </div>
        )}

        {result?.payload && (
          <div className="mt-8">
            <div className="border border-neutral-200 rounded-lg overflow-hidden">
              <div className="bg-neutral-50 px-5 py-3 border-b border-neutral-200">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-neutral-900">{result.payload.store.name}</p>
                    <p className="text-xs text-neutral-500">
                      {result.payload.store.domain} · {result.payload.productCount} products · {result.payload.collectionCount} collections
                    </p>
                  </div>
                  <a
                    href={`/demo/${encodeURIComponent(result.payload.store.domain)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-medium text-neutral-600 hover:text-neutral-900 underline"
                  >
                    Open demo →
                  </a>
                </div>
              </div>
              <div className="divide-y divide-neutral-100">
                {outfits.map((o, idx) => (
                  <div key={idx} className="px-5 py-5">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-sm font-semibold text-neutral-900">
                        {o.outfit_name}
                      </p>
                      <p className="text-xs text-neutral-500">
                        Total {formatPrice(o.total_price, currency)}
                      </p>
                    </div>
                    <div className="grid grid-cols-5 gap-3">
                      <ProductCard p={o.anchor} label="ANCHOR" currency={currency} />
                      {o.items.map((it) => (
                        <ProductCard key={it.id} p={it} currency={currency} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ProductCard({ p, label, currency }) {
  return (
    <div className="text-xs">
      {p.image ? (
        <img
          src={p.image}
          alt={p.title}
          className="w-full aspect-[3/4] object-cover rounded border border-neutral-100 bg-neutral-50"
        />
      ) : (
        <div className="w-full aspect-[3/4] rounded border border-neutral-200 bg-neutral-50 flex items-center justify-center text-neutral-400">
          no image
        </div>
      )}
      {label && (
        <p className="mt-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
          {label}
        </p>
      )}
      <p className="mt-1 text-neutral-800 leading-tight line-clamp-2">{p.title}</p>
      <p className="text-neutral-500">{formatPrice(p.price, currency)}</p>
    </div>
  );
}
