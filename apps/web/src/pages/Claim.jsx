import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';

/**
 * SSO landing page reached via the link the merchant clicks in the Shopify
 * embedded admin. The claim token is itself proof of identity (signed by
 * runa-admin after the install side proved ownership of the shop via HMAC),
 * so we do NOT ask the merchant for email or password — we just exchange the
 * token for a session and drop them on the dashboard.
 */
export default function Claim() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { setUser } = useAuth();

  const token = useMemo(() => searchParams.get('token') || '', [searchParams]);

  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    if (!token) {
      setError(
        'Missing setup link. Re-open the Runa app in your Shopify admin to get a fresh link.'
      );
      return;
    }

    (async () => {
      try {
        const res = await api.post('/auth/claim', { token });
        if (cancelled) return;

        const { token: authToken, user } = res.data || {};
        if (authToken) {
          localStorage.setItem('token', authToken);
          if (typeof setUser === 'function') setUser(user);
        }
        navigate('/', { replace: true });
      } catch (err) {
        if (cancelled) return;
        setError(err.message || 'Could not sign you in. Please try again.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, navigate, setUser]);

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

        {error ? (
          <>
            <div className="p-4 border border-red-200 bg-red-50 text-red-700 text-sm">
              {error}
            </div>
            <p className="mt-8 text-center text-sm text-neutral-500">
              <Link to="/login" className="link">
                Go to sign in
              </Link>
            </p>
          </>
        ) : (
          <div className="flex flex-col items-center text-center">
            <div className="spinner mb-4"></div>
            <p className="text-sm text-neutral-500">Signing you in…</p>
          </div>
        )}
      </div>
    </div>
  );
}
