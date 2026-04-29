import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

function generatePassword(length = 24) {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

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
    .replace(/\/+$/, '');
}

export default function Register() {
  const [email, setEmail] = useState('');
  const [storeUrl, setStoreUrl] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login, register } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const cleanEmail = email.trim().toLowerCase();
    const cleanUrl = normalizeStoreUrl(storeUrl);
    const platform = detectPlatform(cleanUrl);
    const cacheKey = `runa:autoPassword:${cleanEmail}`;

    try {
      const existingPassword = localStorage.getItem(cacheKey);

      if (existingPassword) {
        try {
          await login(cleanEmail, existingPassword);
          navigate('/');
          return;
        } catch (loginErr) {
          // Fall through to register attempt
        }
      }

      const password = generatePassword();
      const name = cleanEmail.split('@')[0];

      try {
        await register(cleanEmail, password, name, {
          storeUrl: cleanUrl,
          platform
        });
        localStorage.setItem(cacheKey, password);
        navigate('/');
      } catch (registerErr) {
        const msg = registerErr.message || '';
        if (/already exists/i.test(msg)) {
          setError(
            'An account with this email already exists. Please sign in instead.'
          );
        } else {
          throw registerErr;
        }
      }
    } catch (err) {
      setError(err.message || 'Failed to create account');
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
            <label className="label">Email</label>
            <input
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="jane@mystore.com"
            />
          </div>

          <div>
            <label className="label">URL of your website</label>
            <input
              type="text"
              className="input"
              value={storeUrl}
              onChange={(e) => setStoreUrl(e.target.value)}
              required
              placeholder="mystore.com"
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
