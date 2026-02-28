import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiEndpoints } from '../services/api';

const PLATFORMS = [
  { value: 'shopify', label: 'Shopify' },
  { value: 'shopify_plus', label: 'Shopify Plus' },
  { value: 'bigcommerce', label: 'BigCommerce' },
  { value: 'woocommerce', label: 'WooCommerce' },
  { value: 'vtex', label: 'VTEX' },
  { value: 'magento', label: 'Magento' },
  { value: 'custom', label: 'Custom API' }
];

export default function Stores() {
  const [showAddModal, setShowAddModal] = useState(false);
  const queryClient = useQueryClient();

  const { data: storesData, isLoading } = useQuery({
    queryKey: ['stores'],
    queryFn: apiEndpoints.getStores
  });

  const stores = storesData?.data?.stores || [];

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between mb-12">
        <div>
          <h1 className="page-title">Stores</h1>
          <p className="page-subtitle">Manage your connected e-commerce stores</p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="btn btn-primary"
        >
          Add Store
        </button>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <div className="spinner"></div>
        </div>
      ) : stores.length === 0 ? (
        <div className="border border-neutral-100 p-16 text-center">
          <div className="empty-state-icon">+</div>
          <p className="empty-state-title">No stores yet</p>
          <p className="empty-state-text mb-8">Connect your first e-commerce store to get started</p>
          <button
            onClick={() => setShowAddModal(true)}
            className="btn btn-primary"
          >
            Add Your First Store
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {stores.map((store) => (
            <StoreCard key={store.id} store={store} />
          ))}
        </div>
      )}

      {/* Add Store Modal */}
      {showAddModal && (
        <AddStoreModal
          onClose={() => setShowAddModal(false)}
          onSuccess={() => {
            setShowAddModal(false);
            queryClient.invalidateQueries(['stores']);
          }}
        />
      )}
    </div>
  );
}

function StoreCard({ store }) {
  const statusStyles = {
    active: 'badge-success',
    pending: 'badge-warning',
    syncing: 'badge-info',
    error: 'badge-error'
  };

  return (
    <Link
      to={`/stores/${store.id}`}
      className="block border border-neutral-100 p-6 hover:border-neutral-300 transition-colors"
    >
      <div className="flex items-start justify-between mb-6">
        <div className="w-12 h-12 bg-neutral-50 flex items-center justify-center">
          <span className="text-sm font-medium text-neutral-600 uppercase">
            {store.platform?.substring(0, 2)}
          </span>
        </div>
        <span className={`badge ${statusStyles[store.status] || 'badge-neutral'}`}>
          {store.status || 'pending'}
        </span>
      </div>

      <h3 className="text-sm font-medium text-neutral-900 mb-1">{store.name}</h3>
      <p className="text-xs text-neutral-500 mb-6">{store.domain}</p>

      <div className="flex justify-between text-xs text-neutral-500">
        <span>{store.productsCount || 0} products</span>
        <span className="uppercase">{store.platform}</span>
      </div>

      {store.lastSync && (
        <p className="text-xs text-neutral-400 mt-4 pt-4 border-t border-neutral-50">
          Last sync: {new Date(store.lastSync).toLocaleDateString()}
        </p>
      )}
    </Link>
  );
}

function AddStoreModal({ onClose, onSuccess }) {
  const [platform, setPlatform] = useState('shopify');
  const [domain, setDomain] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: apiEndpoints.createStore,
    onSuccess: onSuccess,
    onError: (err) => setError(err.message)
  });

  function handleSubmit(e) {
    e.preventDefault();
    setError('');
    mutation.mutate({ platform, domain, accessToken, name: name || domain });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-lg font-light">Add Store</h2>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-900 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {error && (
            <div className="p-4 border border-red-200 bg-red-50 text-red-700 text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="label">Platform</label>
            <select
              className="input"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
            >
              {PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Store Domain</label>
            <input
              type="text"
              className="input"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              required
              placeholder={platform === 'shopify' ? 'mystore.myshopify.com' : 'mystore.com'}
            />
          </div>

          <div>
            <label className="label">Access Token</label>
            <input
              type="password"
              className="input"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              required
              placeholder="API key or access token"
            />
          </div>

          <div>
            <label className="label">Store Name (Optional)</label>
            <input
              type="text"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Store"
            />
          </div>

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-secondary flex-1"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending}
              className="btn btn-primary flex-1"
            >
              {mutation.isPending ? (
                <span className="flex items-center justify-center">
                  <span className="spinner mr-2"></span>
                  Adding
                </span>
              ) : (
                'Add Store'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
