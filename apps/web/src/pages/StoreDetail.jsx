import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiEndpoints } from '../services/api';

export default function StoreDetail() {
  const { storeId } = useParams();
  const queryClient = useQueryClient();
  const [syncProgress, setSyncProgress] = useState(null);

  const { data: storeData, isLoading } = useQuery({
    queryKey: ['store', storeId],
    queryFn: () => apiEndpoints.getStore(storeId)
  });

  const { data: statsData } = useQuery({
    queryKey: ['store-stats', storeId],
    queryFn: () => apiEndpoints.getProductStats(storeId),
    enabled: !!storeId
  });

  const { data: syncStatusData, refetch: refetchStatus } = useQuery({
    queryKey: ['sync-status', storeId],
    queryFn: () => apiEndpoints.getSyncStatus(storeId),
    refetchInterval: syncProgress ? 2000 : false
  });

  const syncMutation = useMutation({
    mutationFn: () => apiEndpoints.startSync(storeId),
    onSuccess: () => {
      setSyncProgress({ status: 'starting' });
      refetchStatus();
    }
  });

  useEffect(() => {
    if (syncStatusData?.data) {
      const status = syncStatusData.data;
      if (status.status === 'running' || status.status === 'queued') {
        setSyncProgress({
          status: status.status,
          progress: status.progress,
          total: status.total
        });
      } else if (status.status === 'completed' || status.status === 'failed') {
        setSyncProgress(null);
        queryClient.invalidateQueries(['store', storeId]);
        queryClient.invalidateQueries(['store-stats', storeId]);
      }
    }
  }, [syncStatusData, storeId, queryClient]);

  const store = storeData?.data;
  const stats = statsData?.data;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="spinner"></div>
      </div>
    );
  }

  if (!store) {
    return (
      <div className="text-center py-16">
        <p className="text-sm text-neutral-500 mb-6">Store not found</p>
        <Link to="/stores" className="btn btn-primary">
          Back to Stores
        </Link>
      </div>
    );
  }

  const statusStyles = {
    active: 'badge-success',
    pending: 'badge-warning',
    syncing: 'badge-info',
    error: 'badge-error'
  };

  return (
    <div className="animate-fade-in">
      {/* Back Link */}
      <Link
        to="/stores"
        className="inline-flex items-center text-xs text-neutral-500 hover:text-neutral-900 uppercase tracking-wide mb-8"
      >
        <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Stores
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-12">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="page-title">{store.name}</h1>
            <span className={`badge ${statusStyles[store.status] || 'badge-neutral'}`}>
              {store.status || 'pending'}
            </span>
          </div>
          <p className="text-sm text-neutral-500">{store.domain}</p>
        </div>
        <button
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending || syncProgress}
          className="btn btn-primary"
        >
          {syncProgress ? (
            <span className="flex items-center">
              <span className="spinner mr-2"></span>
              Syncing
            </span>
          ) : (
            'Sync Products'
          )}
        </button>
      </div>

      {/* Sync Progress */}
      {syncProgress && (
        <div className="border border-blue-100 bg-blue-50 p-6 mb-8">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-blue-900">Syncing products...</span>
            <span className="text-xs text-blue-700">
              {syncProgress.progress || 0} / {syncProgress.total || '?'}
            </span>
          </div>
          <div className="w-full bg-blue-200 h-1">
            <div
              className="bg-blue-600 h-1 transition-all duration-300"
              style={{
                width: syncProgress.total
                  ? `${(syncProgress.progress / syncProgress.total) * 100}%`
                  : '10%'
              }}
            />
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-neutral-100 border border-neutral-100 mb-12">
        <div className="bg-white p-6">
          <p className="text-xs text-neutral-500 uppercase tracking-widest mb-2">Products</p>
          <p className="text-2xl font-light">{stats?.totalProducts || store.productsCount || 0}</p>
        </div>
        <div className="bg-white p-6">
          <p className="text-xs text-neutral-500 uppercase tracking-widest mb-2">Categories</p>
          <p className="text-2xl font-light">{stats?.totalCategories || 0}</p>
        </div>
        <div className="bg-white p-6">
          <p className="text-xs text-neutral-500 uppercase tracking-widest mb-2">Platform</p>
          <p className="text-2xl font-light capitalize">{store.platform}</p>
        </div>
        <div className="bg-white p-6">
          <p className="text-xs text-neutral-500 uppercase tracking-widest mb-2">Last Sync</p>
          <p className="text-2xl font-light">
            {store.lastSync ? new Date(store.lastSync).toLocaleDateString() : '—'}
          </p>
        </div>
      </div>

      {/* Categories */}
      {stats?.categories?.length > 0 && (
        <section className="mb-12">
          <h2 className="section-title">Top Categories</h2>
          <div className="border border-neutral-100 p-6">
            <div className="flex flex-wrap gap-2">
              {stats.categories.map((cat) => (
                <span
                  key={cat.name}
                  className="px-3 py-1.5 bg-neutral-50 text-xs text-neutral-700"
                >
                  {cat.name} <span className="text-neutral-400">({cat.productCount})</span>
                </span>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Actions */}
      <section>
        <h2 className="section-title">Actions</h2>
        <div className="flex flex-wrap gap-3">
          <Link
            to={`/products?storeId=${storeId}`}
            className="btn btn-secondary"
          >
            View Products
          </Link>
          <button className="btn btn-secondary">
            Edit Settings
          </button>
          <button className="btn btn-danger">
            Remove Store
          </button>
        </div>
      </section>
    </div>
  );
}
