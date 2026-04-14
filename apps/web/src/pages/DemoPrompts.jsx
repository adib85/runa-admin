import { useState, useEffect } from 'react';
import DemoNav from '../components/DemoNav';

export default function DemoPrompts() {
  const [prompts, setPrompts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState('selectCollections');

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/demo/prompts');
        if (!res.ok) throw new Error('Failed to load prompts');
        const data = await res.json();
        setPrompts(data.prompts);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  async function handleLoadDefaults() {
    if (!confirm('This will replace your current prompts with the defaults. Continue?')) return;
    try {
      const res = await fetch('/api/demo/prompts/defaults');
      if (!res.ok) throw new Error('Failed to load defaults');
      const data = await res.json();
      setPrompts(data.prompts);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const res = await fetch('/api/demo/prompts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompts }),
      });
      if (!res.ok) throw new Error('Failed to save');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-neutral-200 border-t-neutral-900" />
      </div>
    );
  }

  if (error && !prompts) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50">
        <div className="text-center max-w-sm">
          <p className="text-sm font-medium text-neutral-900 mb-2">Unable to load prompts</p>
          <p className="text-xs text-neutral-500">{error}</p>
        </div>
      </div>
    );
  }

  const promptFields = [
    {
      key: 'selectCollections',
      label: 'Collection Selection',
      description: 'Gemini Call #1 — Receives the full list of store collections and must pick which ones to use for outfit building.',
      variables: [
        {
          name: '{{collectionList}}',
          description: 'Numbered list of ALL store collections. Each line has the collection title and its URL handle. The AI must decide which are product categories vs brand names.',
          example: `1. "'S Max Mara" (handle: s-max-mara)          ← brand name
2. "120% Lino" (handle: 120-lino)               ← brand name
3. "Accessories" (handle: accessories)           ← CATEGORY ✓
4. "Acne Studios" (handle: acne-studios)         ← brand name
5. "Activewear" (handle: activewear-1)           ← category (skip)
6. "Dresses" (handle: dresses)                   ← CATEGORY ✓ (main)
7. "Coats & Jackets" (handle: coats-jackets)     ← CATEGORY ✓ (main)
8. "Tops & Blouses" (handle: tops-blouses)       ← CATEGORY ✓ (main)
9. "Shoes" (handle: shoes)                       ← CATEGORY ✓ (complementary)
10. "Trousers" (handle: trousers-1)              ← CATEGORY ✓ (complementary)
11. "Jewellery" (handle: jewellery)              ← CATEGORY ✓ (complementary)
12. "Bags" (handle: bags)                        ← CATEGORY ✓ (complementary)
13. "Belts" (handle: belts)                      ← CATEGORY ✓ (complementary)
14. "Gift Cards" (handle: gift-cards)            ← skip
... (can be 30-400 collections)`,
          note: 'The AI must return JSON with "main" (hero pieces like dresses, tops) and "complementary" (shoes, bags, accessories). Each entry needs the handle and a reason.',
        },
      ],
    },
    {
      key: 'buildOutfit',
      label: 'Outfit Builder',
      description: 'Gemini Call #2 — Receives products from the selected collections and must pick one anchor product + 3-5 complementary items to build a complete outfit.',
      variables: [
        {
          name: '{{storeName}}',
          description: 'The store display name',
          example: 'RUNWAYHER',
        },
        {
          name: '{{mainCollections}}',
          description: 'Products GROUPED BY COLLECTION. Each collection has a header with its name, handle, and product count, followed by the products inside it. The AI picks the ANCHOR from one of these collections.',
          example: `Collection "Dresses" (dresses):
[{"id":8342626762786,"title":"Givenchy Black Fibres Cocktail Dress","handle":"givenchy-black-dress","type":"Dresses","price":"2813.00","tags":["Black","Clothing"],"image":"https://cdn.shopify.com/..."}, ...]

Collection "Coats & Jackets" (coats-jackets):
[{"id":8335899754530,"title":"Givenchy Black Fibres Coat","handle":"givenchy-black-coat","type":"Coats","price":"2679.00","tags":["Black"],"image":"https://cdn.shopify.com/..."}, ...]

Collection "Tops & Blouses" (tops-blouses):
[{"id":...,"title":"...","handle":"...","type":"...","price":"...","image":"..."}, ...]`,
        },
        {
          name: '{{complementaryCollections}}',
          description: 'Complementary products also GROUPED BY COLLECTION. The AI picks 3-5 items from DIFFERENT collections here to complete the outfit.',
          example: `Collection "Shoes" (shoes):
[{"id":8340846018594,"title":"Fendi Black Nylon Pumps","handle":"fendi-black-pumps","type":"Shoes","price":"954.00","tags":["Black","Shoes"],"image":"https://cdn.shopify.com/..."}, ...]

Collection "Bags" (bags):
[{"id":8335908601890,"title":"Saint Laurent Black Shoulder Bag","handle":"saint-laurent-bag","type":"Bags","price":"1050.00","tags":["Black","Bags"],"image":"https://cdn.shopify.com/..."}, ...]

Collection "Jewellery" (jewellery):
[{"id":8338487738402,"title":"Alessandra Rich Silver Earrings","handle":"alessandra-rich-earrings","type":"Earrings","price":"318.00","tags":["Silver"],"image":"https://cdn.shopify.com/..."}, ...]

Collection "Belts" (belts):
[{"id":8261199298594,"title":"Prada Black Belt","handle":"prada-belt","type":"Belts","price":"672.00","tags":["Black"],"image":"https://cdn.shopify.com/..."}, ...]`,
          note: 'The AI must return JSON with an "anchor" from a main collection + "items" from different complementary collections. Each item needs id, title, handle, price, image, collection, and role.',
        },
      ],
    },
  ];

  return (
    <div>
      <DemoNav />
      <div className="max-w-3xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between mb-10">
        <div>
          <h1 className="text-2xl font-light tracking-tight text-neutral-900">Prompts</h1>
          <p className="text-sm text-neutral-500 mt-2">
            Edit the AI prompts used for demo outfit generation
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleLoadDefaults}
            className="px-4 py-2.5 text-xs font-medium text-neutral-600 border border-neutral-200 rounded hover:bg-neutral-50 transition-colors"
          >
            Load Defaults
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2.5 bg-neutral-900 text-white text-xs font-semibold uppercase tracking-wider rounded hover:bg-neutral-800 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {saved && (
        <div className="mb-6 px-4 py-3 bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg animate-fade-in">
          Prompts saved successfully
        </div>
      )}

      {error && prompts && (
        <div className="mb-6 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-neutral-200 mb-6">
        {promptFields.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`px-5 py-3 text-sm font-medium transition-colors relative ${
              activeTab === key
                ? 'text-neutral-900'
                : 'text-neutral-400 hover:text-neutral-600'
            }`}
          >
            {label}
            {activeTab === key && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-neutral-900" />
            )}
          </button>
        ))}
      </div>

      {/* Active prompt editor */}
      {promptFields.filter(f => f.key === activeTab).map(({ key, description, variables }) => (
        <div key={key}>
          <p className="text-xs text-neutral-400 mb-4">
            {description}
          </p>
          <textarea
            value={prompts[key] || ''}
            onChange={(e) => setPrompts({ ...prompts, [key]: e.target.value })}
            rows={24}
            className="w-full px-4 py-3 bg-white border border-neutral-200 rounded-lg text-sm text-neutral-800 font-mono leading-relaxed focus:outline-none focus:border-neutral-400 transition-colors resize-y"
            spellCheck={false}
          />

          {/* Variable reference */}
          <div className="mt-6 border border-neutral-100 rounded-lg overflow-hidden">
            <div className="bg-neutral-50 px-4 py-2.5 border-b border-neutral-100">
              <p className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">Variable Reference</p>
            </div>
            <div className="divide-y divide-neutral-100">
              {variables.map((v) => (
                <div key={v.name} className="px-5 py-5">
                  <code className="text-xs font-mono font-bold text-neutral-900 bg-neutral-100 px-2.5 py-1 rounded">
                    {v.name}
                  </code>
                  <p className="text-sm text-neutral-600 mt-2.5 leading-relaxed">
                    {v.description}
                  </p>
                  {v.note && (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mt-3">
                      {v.note}
                    </p>
                  )}
                  <details className="mt-3">
                    <summary className="text-xs font-medium text-neutral-400 cursor-pointer hover:text-neutral-600 select-none">
                      Show example data
                    </summary>
                    <pre className="mt-2 px-4 py-3 bg-neutral-900 rounded-lg text-xs text-neutral-300 font-mono overflow-x-auto whitespace-pre-wrap leading-relaxed">
                      {v.example}
                    </pre>
                  </details>
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}

      <div className="mt-8 pt-6 border-t border-neutral-100 flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-5 py-2.5 bg-neutral-900 text-white text-xs font-semibold uppercase tracking-wider rounded hover:bg-neutral-800 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
      </div>
    </div>
  );
}
