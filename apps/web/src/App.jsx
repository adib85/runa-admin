import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { SuperAdminProvider } from './context/SuperAdminContext';

// Pages
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import Stores from './pages/Stores';
import StoreDetail from './pages/StoreDetail';
import Products from './pages/Products';
import Settings from './pages/Settings';

// AI Tools Pages
import AIMerchant from './pages/AIMerchant';
import AIVisualMerchandiser from './pages/AIVisualMerchandiser';
import AIStylist from './pages/AIStylist';
import AIStudio from './pages/AIStudio';
import AIConfig from './pages/AIConfig';
import AICustom from './pages/AICustom';

// Layout
import Layout from './components/Layout';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return children;
}

function App() {
  return (
    <Routes>
      {/* Public routes */}
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />

      {/* Protected routes */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <SuperAdminProvider>
              <Layout />
            </SuperAdminProvider>
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="stores" element={<Stores />} />
        <Route path="stores/:storeId" element={<StoreDetail />} />
        <Route path="products" element={<Products />} />
        <Route path="settings" element={<Settings />} />
        
        {/* AI Tools */}
        <Route path="ai-merchant" element={<AIMerchant />} />
        <Route path="ai-visual-merchandiser" element={<AIVisualMerchandiser />} />
        <Route path="ai-stylist" element={<AIStylist />} />
        <Route path="ai-studio" element={<AIStudio />} />
        <Route path="ai-custom" element={<AICustom />} />
        <Route path="ai-config" element={<AIConfig />} />
      </Route>

      {/* Catch all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
