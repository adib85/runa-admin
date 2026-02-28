import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { apiEndpoints } from '../services/api';

export default function Products() {
  const [searchParams, setSearchParams] = useSearchParams();
  const storeId = searchParams.get('storeId');
  const [selectedStore, setSelectedStore] = useState(storeId || '');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(0);
  const limit = 20;

  // Get stores for dropdown
  const { data: storesData } = useQuery({
    queryKey: ['stores'],
    queryFn: apiEndpoints.getStores
  });

  // Get products
  const { data: productsData, isLoading } = useQuery({
    queryKey: ['products', selectedStore, page],
    queryFn: () => apiEndpoints.getProducts({
      storeId: selectedStore,
      skip: page * limit,
      limit
    }),
    enabled: !!selectedStore
  });

  const stores = storesData?.data?.stores || [];
  const products = productsData?.data?.products || [];
  const pagination = productsData?.data?.pagination || {};

  function handleStoreChange(e) {
    const newStoreId = e.target.value;
    setSelectedStore(newStoreId);
    setPage(0);
    if (newStoreId) {
      setSearchParams({ storeId: newStoreId });
    } else {
      setSearchParams({});
    }
  }

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="page-header">
        <h1 className="page-title">Products</h1>
        <p className="page-subtitle">Browse and search products across your stores</p>
      </div>

      {/* Filters */}
      <div className="border border-neutral-100 p-6 mb-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="label">Store</label>
            <select
              className="input"
              value={selectedStore}
              onChange={handleStoreChange}
            >
              <option value="">Select a store</option>
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Search</label>
            <input
              type="text"
              className="input"
              placeholder="Search products..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Products Grid */}
      {!selectedStore ? (
        <div className="border border-neutral-100 p-16 text-center">
          <div className="empty-state-icon">↑</div>
          <p className="empty-state-title">Select a store</p>
          <p className="empty-state-text">Choose a store from the dropdown above to view its products</p>
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center h-64">
          <div className="spinner"></div>
        </div>
      ) : products.length === 0 ? (
        <div className="border border-neutral-100 p-16 text-center">
          <div className="empty-state-icon">∅</div>
          <p className="empty-state-title">No products found</p>
          <p className="empty-state-text">Try syncing your store to import products</p>
        </div>
      ) : (
        <>
          {/* Product Count */}
          <div className="flex items-center justify-between mb-6">
            <p className="text-xs text-neutral-500">
              {pagination.total?.toLocaleString()} products
            </p>
          </div>

          {/* Grid */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-px bg-neutral-100 border border-neutral-100 mb-8">
            {products.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-neutral-500">
              Showing {page * limit + 1} - {Math.min((page + 1) * limit, pagination.total)} of {pagination.total}
            </p>
            <div className="flex gap-2">
              <button
                className="btn btn-secondary btn-sm"
                disabled={page === 0}
                onClick={() => setPage(p => p - 1)}
              >
                Previous
              </button>
              <button
                className="btn btn-secondary btn-sm"
                disabled={(page + 1) * limit >= pagination.total}
                onClick={() => setPage(p => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ProductCard({ product }) {
  return (
    <div className="bg-white p-4 group">
      {/* Image */}
      <div className="aspect-square bg-neutral-50 mb-4 overflow-hidden">
        {product.image ? (
          <img
            src={product.image}
            alt={product.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <svg className="w-8 h-8 text-neutral-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
        )}
      </div>

      {/* Content */}
      <h3 className="text-xs font-medium text-neutral-900 mb-1 line-clamp-2" title={product.title}>
        {product.title}
      </h3>

      <div className="flex items-center justify-between mt-3">
        <span className="text-sm text-neutral-900">
          {product.currency} {product.minPrice || 0}
        </span>
        {product.hasVariants && product.variants?.length > 0 && (
          <span className="text-xs text-neutral-400">
            {product.variants.length} variants
          </span>
        )}
      </div>
    </div>
  );
}
