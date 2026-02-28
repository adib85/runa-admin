import { createContext, useContext, useState, useEffect } from 'react';
import { api } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    const token = localStorage.getItem('token');
    if (!token) {
      setLoading(false);
      return;
    }

    try {
      const response = await api.get('/auth/me');
      setUser(response.data);
    } catch (error) {
      localStorage.removeItem('token');
    } finally {
      setLoading(false);
    }
  }

  async function login(email, password) {
    const response = await api.post('/auth/login', { email, password });
    const { token, user } = response.data;
    localStorage.setItem('token', token);
    setUser(user);
    return user;
  }

  async function register(email, password, name, extraData = {}) {
    const payload = {
      email,
      password,
      name,
      storeUrl: extraData.storeUrl,
      platform: extraData.platform
    };

    // Include VTEX credentials if provided
    if (extraData.vtexApiKey) {
      payload.vtexApiKey = extraData.vtexApiKey;
    }
    if (extraData.vtexToken) {
      payload.vtexToken = extraData.vtexToken;
    }

    const response = await api.post('/auth/register', payload);
    const { token, user } = response.data;
    localStorage.setItem('token', token);
    setUser(user);
    return user;
  }

  function logout() {
    localStorage.removeItem('token');
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
