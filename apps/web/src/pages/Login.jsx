import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

function normalizeUrl(value) {
  return value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export default function Login() {
  const [step, setStep] = useState(1);
  const [storeUrl, setStoreUrl] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const passwordInputRef = useRef(null);

  useEffect(() => {
    if (step === 2 && passwordInputRef.current) {
      passwordInputRef.current.focus();
    }
  }, [step]);

  function handleContinue(e) {
    e.preventDefault();
    setError('');
    const cleaned = normalizeUrl(storeUrl);
    if (!cleaned) {
      setError('Please enter your store URL');
      return;
    }
    setStoreUrl(cleaned);
    setStep(2);
  }

  function handleEditStore(e) {
    e.preventDefault();
    setError('');
    setPassword('');
    setStep(1);
  }

  async function handleSignIn(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(normalizeUrl(storeUrl), password);
      navigate('/');
    } catch (err) {
      setError(err.message || 'Failed to sign in');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-8 bg-white">
      <div className="w-full max-w-sm">
        <div className="mb-10 flex flex-col items-center text-center">
          <img
            src="https://cdn.prod.website-files.com/6598727d8180e7b6c126a6cf/69344ca971a7628e577f32ab_runa_logo.png"
            alt="Runa"
            className="w-16 h-16 rounded-full mb-4"
          />
          <h1 className="text-2xl font-light tracking-tight">RUNA</h1>
        </div>

        <div className="mb-8 text-center">
          <h2 className="text-2xl font-semibold text-neutral-900">
            Welcome back
          </h2>
          <p className="text-sm text-neutral-500 mt-2">
            {step === 1 ? 'Enter your store URL to continue' : 'Enter your password'}
          </p>
        </div>

        {step === 1 ? (
          <form onSubmit={handleContinue} className="space-y-5">
            {error && (
              <div className="p-4 border border-red-200 bg-red-50 text-red-700 text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="label">Store URL</label>
              <input
                type="text"
                className="input"
                value={storeUrl}
                onChange={(e) => setStoreUrl(e.target.value)}
                required
                autoFocus
                placeholder="mystore.com"
                autoComplete="username"
              />
            </div>

            <button type="submit" className="btn btn-primary w-full mt-2">
              Continue
            </button>
          </form>
        ) : (
          <form onSubmit={handleSignIn} className="space-y-5">
            {error && (
              <div className="p-4 border border-red-200 bg-red-50 text-red-700 text-sm">
                {error}
              </div>
            )}

            <div className="flex items-center justify-between border border-neutral-200 rounded px-4 py-3">
              <div className="min-w-0">
                <p className="text-2xs font-medium uppercase text-neutral-400 tracking-widest">
                  Store
                </p>
                <p className="text-sm text-neutral-900 truncate">{storeUrl}</p>
              </div>
              <button
                type="button"
                onClick={handleEditStore}
                className="text-xs text-neutral-500 hover:text-neutral-900 underline ml-3"
              >
                Change
              </button>
            </div>

            {/* Hidden username field so password managers associate creds with the store. */}
            <input
              type="text"
              name="username"
              value={storeUrl}
              readOnly
              hidden
              autoComplete="username"
            />

            <div>
              <div className="flex items-center justify-between">
                <label className="label">Password</label>
                <Link
                  to="/forgot-password"
                  className="text-xs text-neutral-500 hover:text-neutral-900 underline"
                >
                  Forgot password?
                </Link>
              </div>
              <input
                ref={passwordInputRef}
                type="password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="Enter your password"
                autoComplete="current-password"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="btn btn-primary w-full mt-2"
            >
              {loading ? (
                <span className="flex items-center justify-center">
                  <span className="spinner mr-2"></span>
                  Signing in
                </span>
              ) : (
                'Sign in'
              )}
            </button>
          </form>
        )}

        <p className="mt-8 text-center text-sm text-neutral-500">
          Don't have an account?{' '}
          <Link to="/register" className="link">
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
