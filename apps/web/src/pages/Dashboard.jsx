import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiEndpoints } from '../services/api';

const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [syncStatus, setSyncStatus] = useState(null);
  const [pollInterval, setPollInterval] = useState(null);

  const { data: storesData, isLoading } = useQuery({
    queryKey: ['stores'],
    queryFn: apiEndpoints.getStores
  });

  const stores = storesData?.data?.stores || [];
  const store = stores[0]; // Single store
  const totalProducts = store?.productsCount || 0;
  const isSyncing = syncStatus?.status === 'running' || syncStatus?.status === 'queued';

  // Start sync mutation
  const startSyncMutation = useMutation({
    mutationFn: async (storeId) => {
      const result = await apiEndpoints.startSync(storeId);
      return result.data;
    },
    onSuccess: (data) => {
      setSyncStatus({ 
        status: data.status, 
        progress: 0, 
        total: 0,
        jobId: data.jobId 
      });
      // Start polling for status
      startPolling();
    },
    onError: (error) => {
      alert('Failed to start sync: ' + error.message);
    }
  });

  // Poll for sync status
  const pollSyncStatus = async () => {
    if (!store?.id) return;
    try {
      const result = await apiEndpoints.getSyncStatus(store.id);
      const status = result.data;
      setSyncStatus(status);

      // Stop polling if sync is complete or failed
      if (status.status === 'completed' || status.status === 'failed' || status.status === 'idle') {
        stopPolling();
        // Refresh stores data
        queryClient.invalidateQueries(['stores']);
      }
    } catch (error) {
      console.error('Failed to get sync status:', error);
    }
  };

  const startPolling = () => {
    if (pollInterval) return;
    const interval = setInterval(pollSyncStatus, 2000); // Poll every 2 seconds
    setPollInterval(interval);
  };

  const stopPolling = () => {
    if (pollInterval) {
      clearInterval(pollInterval);
      setPollInterval(null);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [pollInterval]);

  // Check initial sync status on mount
  useEffect(() => {
    if (store?.id) {
      pollSyncStatus();
    }
  }, [store?.id]);

  const handleSyncClick = () => {
    if (!store?.id) return;
    if (isSyncing) return;
    startSyncMutation.mutate(store.id);
  };

  const getSyncButtonText = () => {
    if (startSyncMutation.isPending) return 'Starting...';
    if (syncStatus?.status === 'queued') return 'Starting...';
    if (syncStatus?.status === 'running') {
      const progress = syncStatus.progress || 0;
      const total = syncStatus.total || 0;
      if (total > 0) {
        const pct = Math.round((progress / total) * 100);
        return `Syncing... ${pct}% (${progress}/${total})`;
      }
      return 'Syncing...';
    }
    return 'Sync Products';
  };

  const getSyncStatusText = () => {
    if (syncStatus?.status === 'running' || syncStatus?.status === 'queued') {
      const progress = syncStatus.progress || 0;
      const total = syncStatus.total || 0;
      if (total > 0) {
        return `Syncing ${progress}/${total}`;
      }
      return 'Syncing...';
    }
    if (syncStatus?.status === 'completed') {
      return 'Completed';
    }
    if (syncStatus?.status === 'failed') {
      return 'Error';
    }
    return store ? 'Ready' : 'Pending';
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="spinner"></div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="page-header">
        <h1 className="page-title">Store</h1>
        <p className="page-subtitle">Manage your store and let Runa's AI agents handle the rest.</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-px bg-neutral-100 border border-neutral-100 mb-12">
        <StatCard label="Products" value={totalProducts.toLocaleString()} />
        <StatCard 
          label="Sync Status" 
          value={getSyncStatusText()}
          highlight={isSyncing}
        />
      </div>

      {/* Store Section */}
      <div className="mb-8">
        <h2 className="section-title">Your Store</h2>

        {!store ? (
          <div className="border border-neutral-100 p-12 text-center">
            <p className="text-sm text-neutral-900 mb-2">Connect your store</p>
            <p className="text-xs text-neutral-500 mb-6">
              Once connected, Runa's AI will analyze your catalog and start creating outfit bundles automatically.
            </p>
            <Link to="/settings" className="btn btn-primary">
              Configure Store
            </Link>
          </div>
        ) : (
          <div className="border border-neutral-100">
            <StoreCard store={store} syncStatus={syncStatus} />
            <div className="px-8 pb-8">
              {/* Sync Progress Bar */}
              {isSyncing && syncStatus?.total > 0 && (
                <div className="mb-4">
                  <div className="flex justify-between text-xs text-neutral-500 mb-1">
                    <span>Progress</span>
                    <span>{syncStatus.progress}/{syncStatus.total} products</span>
                  </div>
                  <div className="h-2 bg-neutral-100 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-neutral-900 transition-all duration-300"
                      style={{ width: `${Math.round((syncStatus.progress / syncStatus.total) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
              
              <button
                type="button"
                onClick={handleSyncClick}
                disabled={isSyncing || startSyncMutation.isPending}
                className={`btn ${isSyncing ? 'btn-secondary' : 'btn-primary'}`}
              >
                {isSyncing ? (
                  <svg className="w-4 h-4 mr-2 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                )}
                {getSyncButtonText()}
              </button>

              {/* Sync Error */}
              {syncStatus?.status === 'failed' && syncStatus?.error && (
                <p className="mt-2 text-xs text-red-600">
                  Error: {syncStatus.error}
                </p>
              )}

              {/* Last Sync Info */}
              {store.lastSync && !isSyncing && (
                <p className="mt-2 text-xs text-neutral-500">
                  Last synced: {new Date(store.lastSync).toLocaleString()}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* VTEX Credentials Section - only for VTEX stores */}
      {store?.platform?.toLowerCase() === 'vtex' && (
        <VtexCredentials store={store} />
      )}

      {/* Shopify Credentials Section - only for Shopify stores */}
      {store?.platform?.toLowerCase() === 'shopify' && (
        <ShopifyCredentials store={store} accessToken={storesData?.data?.accessToken} />
      )}

    </div>
  );
}

function StatCard({ label, value, highlight }) {
  return (
    <div className="bg-white p-8">
      <p className="text-xs text-neutral-500 uppercase tracking-widest mb-2">{label}</p>
      <p className={`text-3xl font-light ${highlight ? 'text-blue-600' : 'text-neutral-900'}`}>
        {value}
      </p>
    </div>
  );
}

function StoreCard({ store, syncStatus }) {
  const getStatusDisplay = () => {
    if (syncStatus?.status === 'running' || syncStatus?.status === 'queued') {
      return { label: 'syncing', style: 'badge-info' };
    }
    if (syncStatus?.status === 'failed') {
      return { label: 'error', style: 'badge-error' };
    }
    const status = store.status || 'pending';
    const statusStyles = {
      active: 'badge-success',
      pending: 'badge-warning',
      syncing: 'badge-info',
      error: 'badge-error'
    };
    return { label: status, style: statusStyles[status] || 'badge-neutral' };
  };

  const statusDisplay = getStatusDisplay();

  return (
    <div className="p-8">
      <div className="flex items-start justify-between">
        <div className="flex items-center">
          <div className="w-12 h-12 bg-neutral-100 flex items-center justify-center mr-4 rounded-sm">
            <span className="text-sm font-medium text-neutral-600 uppercase">
              {store.platform?.substring(0, 2)}
            </span>
          </div>
          <div>
            <p className="text-lg font-medium text-neutral-900">{store.name}</p>
            <p className="text-sm text-neutral-500">{store.domain}</p>
          </div>
        </div>
        <span className={`badge ${statusDisplay.style}`}>
          {statusDisplay.label}
        </span>
      </div>
      <div className="mt-6 pt-6 border-t border-neutral-100">
        <div className="grid grid-cols-2 gap-6">
          <div>
            <p className="text-xs text-neutral-500 uppercase tracking-wide mb-1">Products</p>
            <p className="text-sm font-medium text-neutral-900">{store.productsCount || 0}</p>
          </div>
          <div>
            <p className="text-xs text-neutral-500 uppercase tracking-wide mb-1">Platform</p>
            <p className="text-sm font-medium text-neutral-900 capitalize">{store.platform || 'Shopify'}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function VtexCredentials({ store }) {
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [vtexApiKey, setVtexApiKey] = useState(store.vtexApiKey || '');
  const [vtexToken, setVtexToken] = useState(store.vtexToken || '');
  const [saving, setSaving] = useState(false);
  const [showToast, setShowToast] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      // Save to Lambda database - credentials at root level
      const url = `${APP_SERVER_URL}?action=saveUserChat&shop=${store.domain}&contextUpdated=0`;
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          vtexApiKey,
          vtexToken
        })
      });

      setIsEditing(false);
      setShowToast(true);
      setTimeout(() => setShowToast(false), 3000);
      queryClient.invalidateQueries(['stores']);
    } catch (error) {
      console.error('Failed to save VTEX credentials:', error);
      alert('Failed to save credentials: ' + error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setVtexApiKey(store.vtexApiKey || '');
    setVtexToken(store.vtexToken || '');
    setIsEditing(false);
  };

  return (
    <div className="mb-8">
      {showToast && (
        <div className="fixed top-4 right-4 bg-neutral-900 text-white px-6 py-3 rounded-sm shadow-lg z-50 animate-fade-in">
          VTEX credentials saved successfully
        </div>
      )}

      <h2 className="section-title">VTEX Credentials</h2>
      <div className="border border-neutral-100 p-8">
        {isEditing ? (
          <div className="max-w-md space-y-4">
            <div>
              <label className="label">VTEX API Key</label>
              <input
                type="text"
                className="input"
                value={vtexApiKey}
                onChange={(e) => setVtexApiKey(e.target.value)}
                placeholder="Your VTEX API Key"
              />
            </div>
            <div>
              <label className="label">VTEX Token</label>
              <input
                type="password"
                className="input"
                value={vtexToken}
                onChange={(e) => setVtexToken(e.target.value)}
                placeholder="Your VTEX Token"
              />
            </div>
            <div className="flex gap-3 pt-4">
              <button
                type="button"
                onClick={handleCancel}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="btn btn-primary"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              <div>
                <p className="text-xs text-neutral-500 uppercase tracking-wide mb-1">API Key</p>
                <p className="text-sm font-medium text-neutral-900 font-mono">
                  {store.vtexApiKey ? `${store.vtexApiKey.substring(0, 20)}...` : 'Not configured'}
                </p>
              </div>
              <div>
                <p className="text-xs text-neutral-500 uppercase tracking-wide mb-1">Token</p>
                <p className="text-sm font-medium text-neutral-900">
                  {store.vtexToken ? '••••••••••••••••' : 'Not configured'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="btn btn-secondary btn-sm"
            >
              Edit Credentials
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ShopifyCredentials({ store, accessToken }) {
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [token, setToken] = useState(accessToken || '');
  const [saving, setSaving] = useState(false);
  const [showToast, setShowToast] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      // Save to Lambda database - credentials at root level
      const url = `${APP_SERVER_URL}?action=saveUserChat&shop=${store.domain}&contextUpdated=0`;
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          accessToken: token
        })
      });

      setIsEditing(false);
      setShowToast(true);
      setTimeout(() => setShowToast(false), 3000);
      queryClient.invalidateQueries(['stores']);
    } catch (error) {
      console.error('Failed to save Shopify access token:', error);
      alert('Failed to save access token: ' + error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setToken(accessToken || '');
    setIsEditing(false);
  };

  return (
    <div className="mb-8">
      {showToast && (
        <div className="fixed top-4 right-4 bg-neutral-900 text-white px-6 py-3 rounded-sm shadow-lg z-50 animate-fade-in">
          Shopify access token saved successfully
        </div>
      )}

      <h2 className="section-title">Shopify Credentials</h2>
      <div className="border border-neutral-100 p-8">
        {isEditing ? (
          <div className="max-w-md space-y-4">
            <div>
              <label className="label">Access Token</label>
              <input
                type="password"
                className="input font-mono"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="shpat_xxxxxxxxxxxxxxxxxxxx"
              />
              <p className="text-xs text-neutral-500 mt-1">
                Your Shopify Admin API access token
              </p>
            </div>
            <div className="flex gap-3 pt-4">
              <button
                type="button"
                onClick={handleCancel}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="btn btn-primary"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div className="mb-6">
              <p className="text-xs text-neutral-500 uppercase tracking-wide mb-1">Access Token</p>
              <p className="text-sm font-medium text-neutral-900 font-mono">
                {accessToken ? `${accessToken.substring(0, 12)}...${accessToken.substring(accessToken.length - 4)}` : 'Not configured'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="btn btn-secondary btn-sm"
            >
              Edit Access Token
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
