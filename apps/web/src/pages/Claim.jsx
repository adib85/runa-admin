import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';

export default function Claim() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { setUser } = useAuth();

  const token = useMemo(() => searchParams.get('token') || '', [searchParams]);

  const [info, setInfo] = useState(null); // { shop, alreadyClaimed, suggestedEmail }
  const [verifyError, setVerifyError] = useState('');
  const [verifying, setVerifying] = useState(true);

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setVerifying(false);
      setVerifyError('Missing setup link. Re-open the Runa app in your Shopify admin to get a fresh link.');
      return;
    }
    (async () => {
      try {
        const res = await api.get(`/auth/claim?token=${encodeURIComponent(token)}`);
        if (cancelled) return;
        setInfo(res.data);
        if (res.data?.suggestedEmail) setEmail(res.data.suggestedEmail);
      } catch (err) {
        if (cancelled) return;
        setVerifyError(err.message || 'This setup link is invalid.');
      } finally {
        if (!cancelled) setVerifying(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.post('/auth/claim', {
        token,
        email: email.trim().toLowerCase(),
        password,
        name: name.trim() || undefined
      });
      const { token: authToken, user } = res.data;
      if (authToken) {
        localStorage.setItem('token', authToken);
        if (user?.shop) {
          localStorage.setItem(`runa:autoPassword:${user.shop}`, password);
        }
        if (typeof setUser === 'function') setUser(user);
      }
      navigate('/');
    } catch (err) {
      setError(err.message || 'Failed to set up your account');
    } finally {
      setSubmitting(false);
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
            Set up your admin login
          </h2>
          {(info?.domain || info?.shop) && (
            <p className="text-sm text-neutral-500 mt-2">
              for <strong>{info.domain || info.shop}</strong>
            </p>
          )}
        </div>

        {verifying ? (
          <div className="flex items-center justify-center py-10">
            <div className="spinner"></div>
          </div>
        ) : verifyError ? (
          <div className="p-4 border border-red-200 bg-red-50 text-red-700 text-sm">
            {verifyError}
          </div>
        ) : info?.alreadyClaimed ? (
          <div className="p-4 border border-amber-200 bg-amber-50 text-amber-800 text-sm">
            This account has already been set up. Please{' '}
            <Link to="/login" className="link">
              sign in
            </Link>{' '}
            with your store URL and password.
          </div>
        ) : (
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
                autoComplete="email"
              />
            </div>

            <div>
              <label className="label">Your name (optional)</label>
              <input
                type="text"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Doe"
                autoComplete="name"
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
                placeholder="Minimum 6 characters"
                autoComplete="new-password"
              />
            </div>

            <div>
              <label className="label">Confirm password</label>
              <input
                type="password"
                className="input"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={6}
                placeholder="Repeat your password"
                autoComplete="new-password"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="btn btn-primary w-full mt-2"
            >
              {submitting ? (
                <span className="flex items-center justify-center">
                  <span className="spinner mr-2"></span>
                  Setting up
                </span>
              ) : (
                'Create my login'
              )}
            </button>
          </form>
        )}

        <p className="mt-8 text-center text-sm text-neutral-500">
          Already have a login?{' '}
          <Link to="/login" className="link">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
