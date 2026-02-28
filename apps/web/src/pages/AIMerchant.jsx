export default function AIMerchant() {
  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <h1 className="page-title">AI Merchant</h1>
        <p className="page-subtitle">
          Your autonomous merchandising engine that works 24/7 to optimize product placement, detect trends, and maximize revenue
        </p>
      </div>

      {/* Feature Cards */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-sm bg-purple-100 flex items-center justify-center">
              <span className="text-lg">⚡</span>
            </div>
            <h3 className="text-sm font-medium">Trend Engine</h3>
          </div>
          <p className="text-sm text-neutral-500">
            Detects trending patterns and automatically creates themed collections to capitalize on demand spikes.
          </p>
        </div>

        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-sm bg-purple-100 flex items-center justify-center">
              <span className="text-lg">👆</span>
            </div>
            <h3 className="text-sm font-medium">Auto-Outfitter</h3>
          </div>
          <p className="text-sm text-neutral-500">
            Scales "Complete the Look" recommendations across all product pages to increase basket size.
          </p>
        </div>

        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-sm bg-purple-100 flex items-center justify-center">
              <span className="text-lg">🛡️</span>
            </div>
            <h3 className="text-sm font-medium">Inventory Guard</h3>
          </div>
          <p className="text-sm text-neutral-500">
            Automatically excludes low-stock items and prioritizes high-margin products in recommendations.
          </p>
        </div>

        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-sm bg-purple-100 flex items-center justify-center">
              <span className="text-lg">🚀</span>
            </div>
            <h3 className="text-sm font-medium">Smart Merchandiser</h3>
          </div>
          <p className="text-sm text-neutral-500">
            Optimizes product slot placement based on performance, promoting best sellers to premium positions.
          </p>
        </div>

        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-sm bg-purple-100 flex items-center justify-center">
              <span className="text-lg">✨</span>
            </div>
            <h3 className="text-sm font-medium">Smart Labeling</h3>
          </div>
          <p className="text-sm text-neutral-500">
            AI-powered naming that creates engaging collection titles to boost click-through and conversion rates.
          </p>
        </div>

        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-sm bg-purple-100 flex items-center justify-center">
              <span className="text-lg">📊</span>
            </div>
            <h3 className="text-sm font-medium">Daily Summary</h3>
          </div>
          <p className="text-sm text-neutral-500">
            Comprehensive daily reports on AI actions, performance metrics, and revenue impact.
          </p>
        </div>
      </div>
    </div>
  );
}
