export default function AIStudio() {
  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <h1 className="page-title">AI Studio</h1>
        <p className="page-subtitle">
          Create, train, and deploy custom AI models for your business
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-sm bg-neutral-100 flex items-center justify-center">
              <svg className="w-5 h-5 text-neutral-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
              </svg>
            </div>
            <h3 className="text-sm font-medium">Model Training</h3>
          </div>
          <p className="text-sm text-neutral-500">
            Train custom AI models on your unique product data.
          </p>
        </div>

        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-sm bg-neutral-100 flex items-center justify-center">
              <svg className="w-5 h-5 text-neutral-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
            </div>
            <h3 className="text-sm font-medium">API Integration</h3>
          </div>
          <p className="text-sm text-neutral-500">
            Deploy models via API for seamless integration.
          </p>
        </div>

        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-sm bg-neutral-100 flex items-center justify-center">
              <svg className="w-5 h-5 text-neutral-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h3 className="text-sm font-medium">Performance Analytics</h3>
          </div>
          <p className="text-sm text-neutral-500">
            Monitor and optimize your AI models in real-time.
          </p>
        </div>
      </div>

      <div className="mt-12">
        <div className="card bg-neutral-50 border-dashed">
          <div className="text-center py-8">
            <p className="text-sm text-neutral-500 mb-4">
              AI Studio features coming soon
            </p>
            <span className="badge badge-neutral">In Development</span>
          </div>
        </div>
      </div>
    </div>
  );
}
