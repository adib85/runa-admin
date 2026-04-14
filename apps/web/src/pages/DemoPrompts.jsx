import { useState, useEffect } from 'react';

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
      label: 'Collection Selection',
      description: 'Gemini Call #1 — Selects which collections to use for outfit building.',
      variables: [
        {
          name: '{{collectionList}}',
          description: 'Numbered list of all store collections with handles',
          example: `1. "\'S Max Mara" (handle: s-max-mara)
2. "Accessories" (handle: accessories)
3. "Acne Studios" (handle: acne-studios)
4. "Dresses" (handle: dresses)
5. "Coats & Jackets" (handle: coats-jackets)
6. "Shoes" (handle: shoes)
7. "Trousers" (handle: trousers-1)
...`,
        },
      ],
    },
    {
      key: 'buildOutfit',
      label: 'Outfit Builder',
      description: 'Gemini Call #2 — Picks the anchor product and builds the complete outfit.',
      variables: [
        {
          name: '{{storeName}}',
          description: 'The store name',
          example: 'RUNWAYHER',
        },
        {
          name: '{{mainProducts}}',
          description: 'JSON array of ~50 products from main collections (dresses, tops, etc.)',
          example: `[{"id":8342626762786,"title":"Givenchy Black Fibres Cocktail Dress","type":"Dresses","price":"2813.00","tags":["Black","Clothing","Cocktail"],"image":"https://cdn.shopify.com/...","collection":"dresses"}, ...]`,
        },
        {
          name: '{{complementaryProducts}}',
          description: 'JSON array of ~200 products from complementary collections (shoes, bags, jewelry, etc.)',
          example: `[{"id":8343291494434,"title":"Gianvito Rossi Brown Calf Leather Pumps","type":"Shoes","price":"880.00","tags":["Brown","Shoes"],"image":"https://cdn.shopify.com/...","collection":"shoes"}, ...]`,
        },
      ],
    },
  ];

  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between mb-10">
        <div>
          <h1 className="text-2xl font-light tracking-tight text-neutral-900">Demo Prompts</h1>
          <p className="text-sm text-neutral-500 mt-2">
            Edit the AI prompts used for demo outfit generation
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-5 py-2.5 bg-neutral-900 text-white text-xs font-semibold uppercase tracking-wider rounded hover:bg-neutral-800 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
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
                <div key={v.name} className="px-4 py-4">
                  <div className="flex items-baseline gap-3 mb-1.5">
                    <code className="text-xs font-mono font-bold text-neutral-900 bg-neutral-100 px-2 py-0.5 rounded">
                      {v.name}
                    </code>
                    <span className="text-xs text-neutral-500">{v.description}</span>
                  </div>
                  <details className="mt-2">
                    <summary className="text-xs text-neutral-400 cursor-pointer hover:text-neutral-600 select-none">
                      Show example
                    </summary>
                    <pre className="mt-2 px-3 py-2.5 bg-neutral-50 rounded text-xs text-neutral-600 font-mono overflow-x-auto whitespace-pre-wrap leading-relaxed">
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
  );
}
