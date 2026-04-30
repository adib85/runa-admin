import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes('myshopify') || u.includes('shopify')) return 'shopify';
  if (u.includes('vtex')) return 'vtex';
  if (u.includes('bigcommerce')) return 'bigcommerce';
  if (u.includes('magento')) return 'magento';
  if (u.includes('prestashop')) return 'prestashop';
  if (u.includes('shopware')) return 'shopware';
  return 'other';
}

function normalizeStoreUrl(url) {
  return url
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export default function Register() {
  const [storeUrl, setStoreUrl] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { register } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    const cleanUrl = normalizeStoreUrl(storeUrl);
    const cleanEmail = email.trim().toLowerCase();

    if (!cleanUrl) {
      setError('Please enter your store URL');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);
    try {
      const platform = detectPlatform(cleanUrl);
      const name = cleanEmail.split('@')[0];
      await register(cleanEmail, password, name, {
        storeUrl: cleanUrl,
        platform
      });
      navigate('/');
    } catch (err) {
      const msg = err.message || '';
      if (/already exists/i.test(msg)) {
        setError(
          'An admin account for this store already exists. Please sign in instead.'
        );
      } else {
        setError(msg || 'Failed to create account');
      }
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
            Get started for free
          </h2>
          <p className="text-xs text-neutral-500 mt-2">
            14-day free trial · All features unlocked · No credit card required
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {error && (
            <div className="p-4 border border-red-200 bg-red-50 text-red-700 text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="label">URL of your website</label>
            <input
              type="text"
              className="input"
              value={storeUrl}
              onChange={(e) => setStoreUrl(e.target.value)}
              required
              placeholder="mystore.com"
              autoComplete="url"
            />
          </div>

          <div>
            <label className="label">Email</label>
            <input
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="jane@mystore.com"
              autoComplete="email"
            />
          </div>

          <div>
            <label className="label">Password</label>
            <input
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              placeholder="Create a password"
              autoComplete="new-password"
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
                Creating your account
              </span>
            ) : (
              'Create my account'
            )}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-neutral-500">
          Already have an account?{' '}
          <Link to="/login" className="link">
            Sign in
          </Link>
        </p>

        <p className="mt-6 text-center text-xs text-neutral-400 leading-relaxed">
          By creating an account, you agree to our{' '}
          <a
            href="https://www.askruna.ai/terms-of-use"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-neutral-600"
          >
            Terms of Service
          </a>{' '}
          and{' '}
          <a
            href="https://www.askruna.ai/privacy-policy"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-neutral-600"
          >
            Privacy Policy
          </a>
        </p>
      </div>
    </div>
  );
}
