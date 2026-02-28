import { createContext, useContext, useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const SuperAdminContext = createContext(null);

const STORAGE_KEY = 'runa_superadmin';

export function SuperAdminProvider({ children }) {
  const location = useLocation();
  const [isSuperAdmin, setIsSuperAdmin] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  });

  // Check URL param on location change
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('superadmin') === 'true') {
      setIsSuperAdmin(true);
      localStorage.setItem(STORAGE_KEY, 'true');
      // Remove the param from URL without reload
      const newUrl = window.location.pathname;
      window.history.replaceState({}, '', newUrl);
    }
  }, [location]);

  const disableSuperAdmin = () => {
    setIsSuperAdmin(false);
    localStorage.removeItem(STORAGE_KEY);
  };

  return (
    <SuperAdminContext.Provider value={{ isSuperAdmin, disableSuperAdmin }}>
      {children}
    </SuperAdminContext.Provider>
  );
}

export function useSuperAdmin() {
  const context = useContext(SuperAdminContext);
  if (!context) {
    throw new Error('useSuperAdmin must be used within a SuperAdminProvider');
  }
  return context;
}
