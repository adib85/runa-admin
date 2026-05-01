import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { SuperAdminProvider, useSuperAdmin } from './context/SuperAdminContext';
import { OnboardingProvider, useOnboarding } from './context/OnboardingContext';

// Pages
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Claim from './pages/Claim';
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
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (!user) {
    // Preserve where the user was trying to go (and any URL params they had)
    // so the login screen can send them back here after a successful sign in.
    // Used by `?superadmin=…&shop=…` deep links pasted while logged out.
    const target = `${location.pathname}${location.search}${location.hash}`;
    if (target && target !== '/' && target !== '/login') {
      try {
        sessionStorage.setItem('runa:postLoginRedirect', target);
      } catch {
        // ignore
      }
    }
    return <Navigate to="/login" replace />;
  }

  return children;
}

/**
 * Wrap auth-only entry pages (Login, Register, ForgotPassword) so already
 * signed-in users get sent straight to the app instead of seeing the form.
 */
function GuestOnly({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (user) {
    return <Navigate to="/" replace />;
  }

  return children;
}

function OnboardingGate({ children }) {
  const { fullyReady } = useOnboarding();
  const { isSuperAdmin } = useSuperAdmin();
  const location = useLocation();

  // Superadmin always sees everything; everyone else has to finish setup AND
  // wait for a superadmin to flip the AI Stylist live flag.
  if (!fullyReady && !isSuperAdmin && location.pathname !== '/') {
    return <Navigate to="/" replace />;
  }

  return children;
}

const isDemoHost = window.location.hostname.startsWith('demo.');

function App() {
  return (
    <Routes>
      {/* Public routes — auth-entry pages bounce signed-in users to the app */}
      <Route
        path="/login"
        element={
          <GuestOnly>
            <Login />
          </GuestOnly>
        }
      />
      <Route
        path="/register"
        element={
          <GuestOnly>
            <Register />
          </GuestOnly>
        }
      />
      <Route
        path="/forgot-password"
        element={
          <GuestOnly>
            <ForgotPassword />
          </GuestOnly>
        }
      />
      {/* Reset link still usable when signed in (token in URL); same for the
          Shopify SSO claim, which switches the active session for you. */}
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/claim" element={<Claim />} />
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
