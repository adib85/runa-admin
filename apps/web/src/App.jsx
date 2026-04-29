import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { SuperAdminProvider } from './context/SuperAdminContext';
import { OnboardingProvider, useOnboarding } from './context/OnboardingContext';

// Pages
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Home from './pages/Home';
import Dashboard from './pages/Dashboard';
import Stores from './pages/Stores';
import StoreDetail from './pages/StoreDetail';
import Products from './pages/Products';
import Settings from './pages/Settings';
import Demo from './pages/Demo';
import DemoPrompts from './pages/DemoPrompts';
import DemoManual from './pages/DemoManual';

// AI Tools Pages
import AIMerchant from './pages/AIMerchant';
import AIVisualMerchandiser from './pages/AIVisualMerchandiser';
import AIStylist from './pages/AIStylist';
import AIStudio from './pages/AIStudio';
import AIConfig from './pages/AIConfig';
import AICustom from './pages/AICustom';
import DemoSearches from './pages/DemoSearches';

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

function OnboardingGate({ children }) {
  const { isComplete } = useOnboarding();
  const location = useLocation();

  if (!isComplete && location.pathname !== '/') {
    return <Navigate to="/" replace />;
  }

  return children;
}

const isDemoHost = window.location.hostname.startsWith('demo.');

function App() {
  return (
    <Routes>
      {/* Public routes */}
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/demo" element={<Demo />} />
      <Route path="/demo/:domain" element={<Demo />} />
      <Route path="/d/:domain" element={<Demo />} />
      <Route path="/demo-searches" element={<DemoSearches />} />
      <Route path="/demo-prompts" element={<DemoPrompts />} />
      <Route path="/demo-manual" element={<DemoManual />} />

      {isDemoHost ? (
        <>
          {/* On demo.askruna.ai: root shows Demo */}
          <Route path="/" element={<Demo />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </>
      ) : (
        <>
          {/* On admin.askruna.ai / localhost: root shows Home */}
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <SuperAdminProvider>
                  <OnboardingProvider>
                    <Layout />
                  </OnboardingProvider>
                </SuperAdminProvider>
              </ProtectedRoute>
            }
          >
            <Route index element={<Home />} />
            <Route
              path="store"
              element={
                <OnboardingGate>
                  <Dashboard />
                </OnboardingGate>
              }
            />
            <Route
              path="stores"
              element={
                <OnboardingGate>
                  <Stores />
                </OnboardingGate>
              }
            />
            <Route
              path="stores/:storeId"
              element={
                <OnboardingGate>
                  <StoreDetail />
                </OnboardingGate>
              }
            />
            <Route
              path="products"
              element={
                <OnboardingGate>
                  <Products />
                </OnboardingGate>
              }
            />
            <Route
              path="settings"
              element={
                <OnboardingGate>
                  <Settings />
                </OnboardingGate>
              }
            />
            <Route
              path="ai-merchant"
              element={
                <OnboardingGate>
                  <AIMerchant />
                </OnboardingGate>
              }
            />
            <Route
              path="ai-visual-merchandiser"
              element={
                <OnboardingGate>
                  <AIVisualMerchandiser />
                </OnboardingGate>
              }
            />
            <Route
              path="ai-stylist"
              element={
                <OnboardingGate>
                  <AIStylist />
                </OnboardingGate>
              }
            />
            <Route
              path="ai-studio"
              element={
                <OnboardingGate>
                  <AIStudio />
                </OnboardingGate>
              }
            />
            <Route
              path="ai-custom"
              element={
                <OnboardingGate>
                  <AICustom />
                </OnboardingGate>
              }
            />
            <Route
              path="ai-config"
              element={
                <OnboardingGate>
                  <AIConfig />
                </OnboardingGate>
              }
            />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </>
      )}
    </Routes>
  );
}

export default App;
