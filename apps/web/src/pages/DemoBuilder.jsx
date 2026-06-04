import { useState, useEffect } from 'react';
import DemoNav from '../components/DemoNav';
import { formatPrice } from '../utils/formatPrice';

// Fully form-based demo builder. Unlike the "Manual" page (which pastes
// URLs and scrapes product data), here every field is typed by hand:
// site name/domain/currency plus any number of bundles, each with its own
// title (e.g. "Complete the Look", "Complete the Routine"), an anchor
// product and complementary items. The result is written to the same demo
// cache the live demo reads, and saved demos can be re-loaded and edited.

const CURRENCIES = ['USD', 'EUR', 'GBP', 'RON', 'INR', 'PLN', 'TRY', 'AED', 'SEK', 'CHF'];

// Defaults shown as placeholders. Leaving a field blank keeps the default
// on the live demo (these mirror Demo.jsx DEFAULT_COPY). The store name is
// always shown automatically after the headline.
const COPY_DEFAULTS = {
  badge: 'Demo Preview',
  headline: "Here's how Runa would style",
  subhead: 'AI-built outfits from your catalog. Live on your PDPs in 48 hours.',
  tagline: 'Styling',
};
const emptyCopy = () => ({ badge: '', headline: '', subhead: '', tagline: '' });

const emptyProduct = () => ({ title: '', brand: '', price: '', image: '' });
const emptyBundle = () => ({
  title: 'Complete the Look',
  anchor: emptyProduct(),
  items: [emptyProduct()],
});

// Convert a saved cache payload back into editable form state.
function productToForm(p) {
  return {
    title: p?.title || '',
    brand: p?.vendor || '',
    price: p?.price != null ? String(p.price) : '',
    image: p?.image || '',
  };
}
function payloadToForm(payload) {
  const store = {
    name: payload?.store?.name || '',
    domain: payload?.store?.domain || '',
    currency: payload?.store?.currency || 'USD',
  };
  const outfits = [payload?.outfit, ...(payload?.alternativeOutfits || [])].filter(Boolean);
  const bundles = outfits.map((o) => ({
    title: o.bundle_title || o.outfit_name || 'Complete the Look',
    anchor: productToForm(o.anchor),
    items: (o.items || []).map(productToForm),
  }));
  const savedCopy = payload?.copy || {};
  const copy = { ...emptyCopy(), badge: savedCopy.badge || '', headline: savedCopy.headline || '', subhead: savedCopy.subhead || '', tagline: savedCopy.tagline || '' };
  return { store, copy, bundles: bundles.length ? bundles : [emptyBundle()] };
}

export default function DemoBuilder() {
  const [store, setStore] = useState({ name: '', domain: '', currency: '' });
  const [copy, setCopy] = useState(emptyCopy());
  const [bundles, setBundles] = useState([emptyBundle()]);
  const [editingDomain, setEditingDomain] = useState(null);
  const [savedDemos, setSavedDemos] = useState([]);
  const [siteUrl, setSiteUrl] = useState('');
  const [fetchingStore, setFetchingStore] = useState(false);
  const [storeFetchErr, setStoreFetchErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function loadList() {
    try {
      const res = await fetch('/api/demo/builder-list');
      const data = await res.json();
      if (res.ok) setSavedDemos(data.demos || []);
    } catch {
      /* non-blocking */
    }
  }

  useEffect(() => {
    loadList();
  }, []);

  function setStoreField(field, value) {
    setStore((s) => ({ ...s, [field]: value }));
  }

  // Fetch the website homepage → Gemini fills name / domain / currency and
  // suggests demo copy. Name/domain/currency are filled when returned; copy
  // fields are filled only where still empty so manual edits are preserved.
  async function fetchStore() {
    const url = siteUrl.trim();
    if (!url || fetchingStore) return;
    setFetchingStore(true);
    setStoreFetchErr('');
    try {
      const res = await fetch('/api/demo/builder-store-autofill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch website');
      setStore((s) => ({
        name: data.name || s.name,
        domain: data.domain || s.domain,
        currency: data.currency || s.currency,
      }));
      const dc = data.copy || {};
      setCopy((c) => ({
        badge: c.badge || dc.badge || '',
        headline: c.headline || dc.headline || '',
        subhead: c.subhead || dc.subhead || '',
        tagline: c.tagline || dc.tagline || '',
      }));
    } catch (e) {
      setStoreFetchErr(e.message);
    } finally {
      setFetchingStore(false);
    }
  }

  function updateBundle(bi, patch) {
    setBundles((bs) => bs.map((b, i) => (i === bi ? { ...b, ...patch } : b)));
  }

  function updateAnchor(bi, field, value) {
    setBundles((bs) =>
      bs.map((b, i) => (i === bi ? { ...b, anchor: { ...b.anchor, [field]: value } } : b)),
    );
  }

  function updateItem(bi, ii, field, value) {
    setBundles((bs) =>
      bs.map((b, i) =>
        i === bi
          ? { ...b, items: b.items.map((it, j) => (j === ii ? { ...it, [field]: value } : it)) }
          : b,
      ),
    );
  }

  function addItem(bi) {
    setBundles((bs) => bs.map((b, i) => (i === bi ? { ...b, items: [...b.items, emptyProduct()] } : b)));
  }

  function removeItem(bi, ii) {
    setBundles((bs) =>
      bs.map((b, i) => (i === bi ? { ...b, items: b.items.filter((_, j) => j !== ii) } : b)),
    );
  }

  function addBundle() {
    setBundles((bs) => [...bs, emptyBundle()]);
  }

  function removeBundle(bi) {
    setBundles((bs) => bs.filter((_, i) => i !== bi));
  }

  // Merge several fields into the anchor / an item at once (used by autofill).
  function fillAnchor(bi, fields) {
    setBundles((bs) =>
      bs.map((b, i) => (i === bi ? { ...b, anchor: { ...b.anchor, ...fields } } : b)),
    );
  }
  function fillItem(bi, ii, fields) {
    setBundles((bs) =>
      bs.map((b, i) =>
        i === bi
          ? { ...b, items: b.items.map((it, j) => (j === ii ? { ...it, ...fields } : it)) }
          : b,
      ),
    );
  }

  // Fetch a product URL → Gemini extracts the fields → fill them in.
  // Only non-empty returned fields overwrite, so manual edits are preserved.
  async function autofill(applyFields, url) {
    const res = await fetch('/api/demo/builder-autofill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch from URL');
    const fields = {};
    if (data.title) fields.title = data.title;
    if (data.brand) fields.brand = data.brand;
    if (data.price) fields.price = String(data.price);
    if (data.image) fields.image = data.image;
    applyFields(fields);
    // Currency is site-level — set it from the page if we don't have one yet.
    if (data.currency && !store.currency) setStoreField('currency', data.currency);
  }

  // Simple reordering of the "complete the look" bundles.
  function moveBundle(bi, dir) {
    setBundles((bs) => {
      const target = bi + dir;
      if (target < 0 || target >= bs.length) return bs;
      const copy = [...bs];
      [copy[bi], copy[target]] = [copy[target], copy[bi]];
      return copy;
    });
  }

  function newDemo() {
    setStore({ name: '', domain: '', currency: '' });
    setCopy(emptyCopy());
    setBundles([emptyBundle()]);
    setEditingDomain(null);
    setResult(null);
    setError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function editDemo(domain) {
    setLoadingDemo(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch(`/api/demo/builder/${encodeURIComponent(domain)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load demo');
      const form = payloadToForm(data.payload);
      setStore(form.store);
      setCopy(form.copy);
      setBundles(form.bundles);
      setEditingDomain(domain);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingDemo(false);
    }
  }

  async function deleteDemo(domain) {
    if (!window.confirm(`Delete the demo for ${domain}? This cannot be undone.`)) return;
    try {
      await fetch(`/api/demo/cache/${encodeURIComponent(domain)}`, { method: 'DELETE' });
      if (editingDomain === domain) newDemo();
      loadList();
    } catch (err) {
      setError(err.message);
    }
  }

  async function run({ dryRun }) {
    if (!store.name.trim() || !store.domain.trim()) {
      setError('Website name and domain are required.');
      return;
    }
    setBusy(true);
    setResult(null);
    setError('');
    try {
      const res = await fetch('/api/demo/seed-builder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store, copy, bundles, dryRun }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      setResult(data);
      if (!dryRun) {
        setEditingDomain(data.domain);
        loadList();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const previewOutfits = result?.payload
    ? [result.payload.outfit, ...(result.payload.alternativeOutfits || [])]
    : [];
  const previewCurrency = result?.payload?.store?.currency || store.currency || 'USD';

  return (
    <div>
      <DemoNav />
      <div className="max-w-3xl mx-auto px-6 py-12">
        <div className="mb-8">
          <h1 className="text-2xl font-light tracking-tight text-neutral-900">Demo Builder</h1>
          <p className="text-sm text-neutral-500 mt-2">
            Build a demo entirely by hand — no scraping. Set the website name, domain and
            currency, then add as many bundles as you like. Each bundle has its own title
            (e.g. <span className="font-mono">Complete the Look</span>,{' '}
            <span className="font-mono">Complete the Routine</span>), an anchor product and its
            complementary items. Saving writes the demo cache for that domain.
          </p>
        </div>

        {/* ─── Saved demos ──────────────────────────────────────── */}
        {savedDemos.length > 0 && (
          <div className="border border-neutral-200 rounded-lg p-5 mb-8">
            <p className="text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-3">
              Saved demos
            </p>
            <div className="divide-y divide-neutral-100">
              {savedDemos.map((d) => (
                <div key={d.domain} className="flex items-center justify-between py-2.5 gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-neutral-900 truncate">
                      {d.name}
                      {editingDomain === d.domain && (
                        <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-purple-600">
                          editing
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-neutral-500 truncate">
                      {d.domain} · {d.bundleCount} bundle{d.bundleCount === 1 ? '' : 's'} · {d.currency}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 text-xs">
                    <button
                      onClick={() => editDemo(d.domain)}
                      className="font-medium text-neutral-700 hover:text-neutral-900 underline"
                    >
                      Edit
                    </button>
                    <a
                      href={`/demo/${encodeURIComponent(d.domain)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-neutral-600 hover:text-neutral-900 underline"
                    >
                      Open
                    </a>
                    <button
                      onClick={() => deleteDemo(d.domain)}
                      className="font-medium text-neutral-400 hover:text-red-600"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ─── Editing banner ───────────────────────────────────── */}
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm text-neutral-500">
            {editingDomain ? (
              <>Editing <span className="font-medium text-neutral-800">{editingDomain}</span></>
            ) : (
              'New demo'
            )}
            {loadingDemo && <span className="ml-2 text-neutral-400">loading…</span>}
          </p>
          {(editingDomain || store.name || store.domain) && (
            <button
              onClick={newDemo}
              className="text-xs font-medium text-neutral-600 hover:text-neutral-900 underline"
            >
              + New demo
            </button>
          )}
        </div>

        {/* ─── Site ─────────────────────────────────────────────── */}
        <div className="border border-neutral-200 rounded-lg p-5 mb-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-3">Website</p>

          {/* Auto-fill the whole site from its homepage URL */}
          <div className="mb-2">
            <div className="flex gap-2">
              <input
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    fetchStore();
                  }
                }}
                placeholder="Paste the website homepage URL to auto-fill name, currency & messages…"
                className={inputCls}
              />
              <button
                onClick={fetchStore}
                disabled={fetchingStore || !siteUrl.trim()}
                className="flex-shrink-0 px-4 py-2 bg-purple-600 text-white text-xs font-semibold uppercase tracking-wider rounded-md hover:bg-purple-700 disabled:opacity-40 transition-colors"
              >
                {fetchingStore ? 'Fetching…' : 'Fetch'}
              </button>
            </div>
            {storeFetchErr && <p className="text-xs text-red-600 mt-1">{storeFetchErr}</p>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
            <Field label="Name">
              <input
                value={store.name}
                onChange={(e) => setStoreField('name', e.target.value)}
                placeholder="Fashion Days"
                className={inputCls}
              />
            </Field>
            <Field label="Domain">
              <input
                value={store.domain}
                onChange={(e) => setStoreField('domain', e.target.value)}
                placeholder="fashiondays.ro"
                className={inputCls}
              />
            </Field>
            <Field label="Currency">
              <input
                value={store.currency}
                onChange={(e) => setStoreField('currency', e.target.value.toUpperCase())}
                list="builder-currencies"
                placeholder="USD"
                className={inputCls}
              />
              <datalist id="builder-currencies">
                {CURRENCIES.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
          </div>

          {/* Customizable demo copy */}
          <div className="mt-6 pt-5 border-t border-neutral-100">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-1">
              Demo messages <span className="font-normal normal-case text-neutral-400">— optional, leave blank to use defaults</span>
            </p>
            <p className="text-xs text-neutral-400 mb-3">
              These are the lines a visitor sees on the live demo (badge, headline, sub-text and the
              loading verb). The website name is always shown after the headline automatically.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Headline">
                <input
                  value={copy.headline}
                  onChange={(e) => setCopy((c) => ({ ...c, headline: e.target.value }))}
                  placeholder={COPY_DEFAULTS.headline}
                  className={inputCls}
                />
              </Field>
              <Field label="Badge">
                <input
                  value={copy.badge}
                  onChange={(e) => setCopy((c) => ({ ...c, badge: e.target.value }))}
                  placeholder={COPY_DEFAULTS.badge}
                  className={inputCls}
                />
              </Field>
              <Field label="Sub-text">
                <input
                  value={copy.subhead}
                  onChange={(e) => setCopy((c) => ({ ...c, subhead: e.target.value }))}
                  placeholder={COPY_DEFAULTS.subhead}
                  className={inputCls}
                />
              </Field>
              <Field label="Loading verb (e.g. “Styling”, “Building”)">
                <input
                  value={copy.tagline}
                  onChange={(e) => setCopy((c) => ({ ...c, tagline: e.target.value }))}
                  placeholder={COPY_DEFAULTS.tagline}
                  className={inputCls}
                />
              </Field>
            </div>
          </div>
        </div>

        {/* ─── Bundles ──────────────────────────────────────────── */}
        {bundles.map((bundle, bi) => (
          <div key={bi} className="border border-neutral-200 rounded-lg p-5 mb-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
                  Bundle {bi + 1}
                </span>
                <button
                  onClick={() => moveBundle(bi, -1)}
                  disabled={bi === 0}
                  title="Move up"
                  className="text-neutral-400 hover:text-neutral-800 disabled:opacity-30 disabled:hover:text-neutral-400 leading-none"
                >
                  ↑
                </button>
                <button
                  onClick={() => moveBundle(bi, 1)}
                  disabled={bi === bundles.length - 1}
                  title="Move down"
                  className="text-neutral-400 hover:text-neutral-800 disabled:opacity-30 disabled:hover:text-neutral-400 leading-none"
                >
                  ↓
                </button>
              </div>
              {bundles.length > 1 && (
                <button
                  onClick={() => removeBundle(bi)}
                  className="text-xs text-neutral-400 hover:text-red-600 transition-colors"
                >
                  Remove bundle
                </button>
              )}
            </div>

            <Field label="Bundle title">
              <input
                value={bundle.title}
                onChange={(e) => updateBundle(bi, { title: e.target.value })}
                placeholder="Complete the Look"
                className={inputCls}
              />
            </Field>

            <div className="mt-5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-2">
                Anchor product
              </p>
              <ProductFields
                product={bundle.anchor}
                onChange={(field, value) => updateAnchor(bi, field, value)}
                onAutofill={(url) => autofill((f) => fillAnchor(bi, f), url)}
              />
            </div>

            <div className="mt-6">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-2">
                Complementary items
              </p>
              <div className="space-y-3">
                {bundle.items.map((item, ii) => (
                  <div key={ii} className="flex items-start gap-3">
                    <div className="flex-1">
                      <ProductFields
                        product={item}
                        onChange={(field, value) => updateItem(bi, ii, field, value)}
                        onAutofill={(url) => autofill((f) => fillItem(bi, ii, f), url)}
                      />
                    </div>
                    <button
                      onClick={() => removeItem(bi, ii)}
                      className="mt-1 text-neutral-300 hover:text-red-600 transition-colors text-lg leading-none"
                      title="Remove item"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={() => addItem(bi)}
                className="mt-3 text-xs font-medium text-neutral-600 hover:text-neutral-900 underline"
              >
                + Add item
              </button>
            </div>
          </div>
        ))}

        <button
          onClick={addBundle}
          className="w-full py-3 border border-dashed border-neutral-300 rounded-lg text-sm text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 transition-colors mb-6"
        >
          + Add bundle
        </button>

        {/* ─── Actions ──────────────────────────────────────────── */}
        <div className="flex items-center gap-3">
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
            {busy ? 'Saving…' : editingDomain ? 'Save changes' : 'Save to Cache'}
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

        {/* ─── Result preview ───────────────────────────────────── */}
        {result?.payload && (
          <div className="mt-8">
            <div className="border border-neutral-200 rounded-lg overflow-hidden">
              <div className="bg-neutral-50 px-5 py-3 border-b border-neutral-200">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-neutral-900">{result.payload.store.name}</p>
                    <p className="text-xs text-neutral-500">
                      {result.payload.store.domain} · {result.payload.productCount} products ·{' '}
                      {result.payload.collectionCount} bundles
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
                {previewOutfits.map((o, idx) => (
                  <div key={idx} className="px-5 py-5">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-sm font-semibold text-neutral-900">
                        {o.bundle_title || o.outfit_name}
                      </p>
                      <p className="text-xs text-neutral-500">
                        Total {formatPrice(o.total_price, previewCurrency)}
                      </p>
                    </div>
                    <div className="grid grid-cols-5 gap-3">
                      <ProductCard p={o.anchor} label="ANCHOR" currency={previewCurrency} />
                      {o.items.map((it) => (
                        <ProductCard key={it.id} p={it} currency={previewCurrency} />
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

const inputCls =
  'w-full px-3 py-2 bg-white border border-neutral-200 rounded-md text-sm text-neutral-800 focus:outline-none focus:border-neutral-400 transition-colors';

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-medium text-neutral-500 mb-1">{label}</span>
      {children}
    </label>
  );
}

function ProductFields({ product, onChange, onAutofill }) {
  const [link, setLink] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fetchErr, setFetchErr] = useState('');

  async function doFetch() {
    const url = link.trim();
    if (!url || fetching) return;
    setFetching(true);
    setFetchErr('');
    try {
      await onAutofill(url);
    } catch (e) {
      setFetchErr(e.message || 'Fetch failed');
    } finally {
      setFetching(false);
    }
  }

  return (
    <div>
      {onAutofill && (
        <div className="mb-2">
          <div className="flex gap-2">
            <input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  doFetch();
                }
              }}
              placeholder="Paste a product URL to auto-fill with Gemini…"
              className={inputCls}
            />
            <button
              onClick={doFetch}
              disabled={fetching || !link.trim()}
              className="flex-shrink-0 px-4 py-2 bg-purple-600 text-white text-xs font-semibold uppercase tracking-wider rounded-md hover:bg-purple-700 disabled:opacity-40 transition-colors"
            >
              {fetching ? 'Fetching…' : 'Fetch'}
            </button>
          </div>
          {fetchErr && <p className="text-xs text-red-600 mt-1">{fetchErr}</p>}
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
      <div className="sm:col-span-5">
        <input
          value={product.title}
          onChange={(e) => onChange('title', e.target.value)}
          placeholder="Title"
          className={inputCls}
        />
      </div>
      <div className="sm:col-span-3">
        <input
          value={product.brand}
          onChange={(e) => onChange('brand', e.target.value)}
          placeholder="Brand (optional)"
          className={inputCls}
        />
      </div>
      <div className="sm:col-span-2">
        <input
          value={product.price}
          onChange={(e) => onChange('price', e.target.value)}
          placeholder="Price"
          inputMode="decimal"
          className={inputCls}
        />
      </div>
      <div className="sm:col-span-2">
        <input
          value={product.image}
          onChange={(e) => onChange('image', e.target.value)}
          placeholder="Image URL"
          className={inputCls}
        />
      </div>
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
        <p className="mt-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{label}</p>
      )}
      <p className="mt-1 text-neutral-800 leading-tight line-clamp-2">{p.title}</p>
      {p.vendor && <p className="text-neutral-400">{p.vendor}</p>}
      <p className="text-neutral-500">{formatPrice(p.price, currency)}</p>
    </div>
  );
}
