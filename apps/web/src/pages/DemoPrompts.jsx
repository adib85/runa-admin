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
      label: 'Collections',
      description: 'Gemini Call #1 — Picks 8-10 product category collections. Men\'s collections are auto-filtered out for multi-gender stores.',
      variables: [
        {
          name: '{{collectionList}}',
          description: 'Numbered list of store collections with product counts. Each line shows: title, URL handle, and number of products. Collections with <5 products and men\'s collections (on multi-gender stores) are pre-filtered before this prompt runs.',
          example: `1. "Womens: Dresses" (handle: womens-dresses, 292 products)
2. "Womens: Tops" (handle: womens-tops, 819 products)
3. "Womens: Jackets & Coats" (handle: womens-jackets-coats, 128 products)
4. "Womens: Pants" (handle: womens-pants, 222 products)
5. "Womens: Shoes" (handle: womens-shoes, 12 products)
6. "Womens: Bags & Shoes" (handle: womens-bags-and-shoes, 65 products)
7. "Womens: Accessories" (handle: womens-accessories, 130 products)
8. "Womens: Knitwear" (handle: womens-knitwear, 120 products)
9. "Womens: Skirts" (handle: womens-skirts, 121 products)
10. "Womens: Earrings" (handle: womens-earrings, 39 products)
... (typically 30-200 collections after filtering)`,
          note: 'Must return: {"collections": [{"handle":"...","title":"...","reason":"..."}]}. Pick 8-10 CATEGORY collections (not brands). Include a mix of clothing, footwear, and accessories.',
        },
      ],
    },
    {
      key: 'selectAnchors',
      label: 'Anchor Selection',
      description: 'Gemini Call #2 — Picks 5 anchor product IDs from different categories. The top 3 are used, 2 are backups in case any outfit fails.',
      variables: [
        {
          name: '{{storeName}}',
          description: 'The store display name (e.g., "BRONZE SNAKE", "RUNWAYHER")',
          example: 'BRONZE SNAKE',
        },
        {
          name: '{{allCollections}}',
          description: 'All fetched products grouped by collection. Each product has only id, title, and price (slim format to save tokens). The AI sees ~400 products across 8-10 collections.',
          example: `Collection "Womens: Dresses" (womens-dresses):
[{"id":9087123456,"title":"Deserae Low Plunge Maxi Dress Chocolate","price":"169.00"},{"id":9087123457,"title":"Touch Mini Dress Noir","price":"109.00"}, ...]

Collection "Womens: Jackets & Coats" (womens-jackets-coats):
[{"id":9087234567,"title":"Rhode Bomber Chocolate","price":"148.00"},{"id":9087234568,"title":"Layilla Jacket Beige","price":"148.00"}, ...]

Collection "Womens: Bags & Shoes" (womens-bags-and-shoes):
[{"id":9087345678,"title":"Elena Handle Bag Dark Choc","price":"75.00"},{"id":9087345679,"title":"Alias Mae Kruz Black","price":"249.95"}, ...]`,
          note: 'Must return ONLY IDs: {"anchors": [9087123456, 9087234567, 9087345678, 9087456789, 9087567890]}. Pick from DIFFERENT collections. Ideal: 2 clothing, 1-2 accessories/shoes, 1 knitwear/outerwear.',
        },
      ],
    },
    {
      key: 'buildOutfit',
      label: 'Outfit Builder',
      description: 'Gemini Call #3 (runs 3x in parallel) — Builds one outfit around a specific anchor. The AI also receives the anchor\'s actual product IMAGE to match colors/style visually.',
      variables: [
        {
          name: '{{storeName}}',
          description: 'The store display name',
          example: 'BRONZE SNAKE',
        },
        {
          name: '{{anchorProduct}}',
          description: 'The specific anchor product as JSON. The AI also receives the anchor\'s IMAGE as a separate visual input (not shown here).',
          example: `{"id":9087123456,"title":"Deserae Low Plunge Maxi Dress Chocolate","type":"Dresses","price":"169.00","collection":"womens-dresses"}`,
          note: 'The anchor\'s photo is sent alongside this JSON so the AI can see the actual colors, fabric, and style.',
        },
        {
          name: '{{availableCollections}}',
          description: 'Products from all OTHER collections (anchor\'s collection + same product type are excluded). Each product has id, title, price only.',
          example: `Collection "Womens: Jackets & Coats" (womens-jackets-coats):
[{"id":9087234567,"title":"Rhode Bomber Chocolate","price":"148.00"}, ...]

Collection "Womens: Bags & Shoes" (womens-bags-and-shoes):
[{"id":9087345678,"title":"Elena Handle Bag Dark Choc","price":"75.00"}, ...]

Collection "Womens: Earrings" (womens-earrings):
[{"id":9087456789,"title":"Crystal Huggie Earrings Gold","price":"37.00"}, ...]

Collection "Womens: Belts" (womens-belts):
[{"id":9087567890,"title":"Marni Belt Tan","price":"49.00"}, ...]`,
          note: 'Must return ONLY IDs + outfit name: {"items": [9087234567, 9087345678, 9087456789], "outfit_name": "Chocolate Evening"}. Return 3-4 IDs. STYLE COHERENCE is key: evening anchor = evening items, casual anchor = casual items.',
        },
      ],
    },
    {
      key: 'criticOutfit',
      label: 'Critic',
      description: 'Gemini Call #4 (runs 3x in parallel) — Reviews each outfit with product images. If score < 7, the outfit is rebuilt with critic feedback.',
      variables: [
        {
          name: '{{anchor}}',
          description: 'The anchor product title and collection',
          example: '"Deserae Low Plunge Maxi Dress Chocolate" (womens-dresses)',
        },
        {
          name: '{{items}}',
          description: 'Numbered list of complementary items with their collections',
          example: `0: "Rhode Bomber Chocolate" (womens-jackets-coats)
1: "Elena Handle Bag Dark Choc" (womens-bags-and-shoes)
2: "Crystal Huggie Earrings Gold" (womens-earrings)`,
          note: 'The critic also receives actual product IMAGES (anchor + all items). Returns: {"score": 8, "approved": true/false, "issues": [...], "remove_indexes": [...]}. If rejected, the outfit builder re-runs with the issues as feedback.',
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
      <div className="flex border-b border-neutral-200 mb-6 overflow-x-auto">
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
