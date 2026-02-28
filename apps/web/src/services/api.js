const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }

  getHeaders() {
    const headers = {
      'Content-Type': 'application/json'
    };

    const token = localStorage.getItem('token');
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return headers;
  }

  async request(method, path, data = null) {
    const url = `${this.baseUrl}${path}`;
    const options = {
      method,
      headers: this.getHeaders()
    };

    if (data && method !== 'GET') {
      options.body = JSON.stringify(data);
    }

    let response;
    try {
      response = await fetch(url, options);
    } catch (err) {
      throw new Error('Unable to connect to server. Please ensure the API is running.');
    }

    // Handle 401 - redirect to login
    if (response.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
      throw new Error('Unauthorized');
    }

    // Handle empty responses
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch (err) {
      throw new Error('Invalid response from server');
    }

    if (!response.ok) {
      throw new Error(json.error || json.message || 'Request failed');
    }

    return { data: json, status: response.status };
  }

  get(path) {
    return this.request('GET', path);
  }

  post(path, data) {
    return this.request('POST', path, data);
  }

  put(path, data) {
    return this.request('PUT', path, data);
  }

  delete(path) {
    return this.request('DELETE', path);
  }
}

export const api = new ApiClient(API_URL);

// Convenience hooks for React Query
export const apiEndpoints = {
  // Auth
  login: (data) => api.post('/auth/login', data),
  register: (data) => api.post('/auth/register', data),
  me: () => api.get('/auth/me'),

  // Stores
  getStores: () => api.get('/stores'),
  getStore: (id) => api.get(`/stores/${id}`),
  createStore: (data) => api.post('/stores', data),
  updateStore: (id, data) => api.put(`/stores/${id}`, data),
  deleteStore: (id) => api.delete(`/stores/${id}`),
  getStoreCategories: (id) => api.get(`/stores/${id}/categories`),

  // Products
  getProducts: (params) => {
    const query = new URLSearchParams(params).toString();
    return api.get(`/products?${query}`);
  },
  getProduct: (id, storeId) => api.get(`/products/${id}?storeId=${storeId}`),
  searchProducts: (data) => api.post('/products/search', data),
  getProductStats: (storeId) => api.get(`/products/stats/${storeId}`),

  // Sync
  startSync: (storeId) => api.post('/sync/start', { storeId }),
  getSyncStatus: (storeId) => api.get(`/sync/status/${storeId}`),
  cancelSync: (storeId) => api.post(`/sync/cancel/${storeId}`),
  getSyncHistory: (storeId) => api.get(`/sync/history/${storeId}`),

  // AI Custom
  getProductDescription: (data) => api.post('/ai/product-description', data),
  getProductDescriptionBatch: (data) => api.post('/ai/product-description-batch', data)
};

export default api;
