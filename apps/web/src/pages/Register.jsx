import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";

const PLATFORMS = [
  { value: 'shopify', label: 'Shopify' },
  { value: 'shopify_plus', label: 'Shopify Plus' },
  { value: 'bigcommerce', label: 'BigCommerce' },
  { value: 'commercetools', label: 'Commercetools' },
  { value: 'magento', label: 'Magento' },
  { value: 'magento2', label: 'Magento 2' },
  { value: 'prestashop', label: 'PrestaShop' },
  { value: 'salesforce', label: 'Salesforce Commerce Cloud' },
  { value: 'shopware', label: 'Shopware' },
  { value: 'vtex', label: 'VTEX' },
  { value: 'custom', label: 'Custom Platform' },
  { value: 'other', label: 'Other' }
];

export default function Register() {
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    storeUrl: '',
    platform: '',
    vtexApiKey: '',
    vtexToken: ''
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { register } = useAuth();
  const navigate = useNavigate();

  function handleChange(e) {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  }

  function handleNextStep(e) {
    e.preventDefault();
    setError('');
    
    // Validate step 1 fields
    if (!formData.name.trim()) {
      setError('Please enter your name');
      return;
    }
    if (!formData.email.trim()) {
      setError('Please enter your email');
      return;
    }
    if (formData.password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    
    setStep(2);
  }

  function handleBack() {
    setError('');
    setStep(1);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (!formData.storeUrl.trim()) {
      setError('Please enter your store URL');
      return;
    }

    if (!formData.platform) {
      setError('Please select your e-commerce platform');
      return;
    }

    // Validate VTEX credentials if VTEX is selected
    if (formData.platform === 'vtex') {
      if (!formData.vtexApiKey.trim()) {
        setError('Please enter your VTEX API Key');
        return;
      }
      if (!formData.vtexToken.trim()) {
        setError('Please enter your VTEX Token');
        return;
      }
    }

    setLoading(true);

    try {
      const storeData = {
        storeUrl: formData.storeUrl,
        platform: formData.platform
      };

      // Include VTEX credentials if platform is VTEX
      if (formData.platform === 'vtex') {
        storeData.vtexApiKey = formData.vtexApiKey;
        storeData.vtexToken = formData.vtexToken;
      }

      await register(formData.email, formData.password, formData.name, storeData);

      // Save VTEX credentials to external database via Lambda
      if (formData.platform === 'vtex') {
        try {
          const url = `${APP_SERVER_URL}?action=saveUserChat&shop=${formData.storeUrl}&contextUpdated=0`;
          await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              chat: {
                vtexApiKey: formData.vtexApiKey,
                vtexToken: formData.vtexToken,
                platform: 'vtex',
                storeUrl: formData.storeUrl
              }
            })
          });
        } catch (lambdaErr) {
          console.error('Failed to save to Lambda:', lambdaErr);
          // Don't block registration if Lambda save fails
        }
      }

      navigate('/');
    } catch (err) {
      setError(err.message || 'Failed to register');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex">
      {/* Left side - Branding */}
      <div className="hidden lg:flex lg:w-1/2 bg-neutral-950 items-center justify-center p-12">
        <div className="max-w-md">
          <h1 className="text-4xl font-light text-white tracking-tight mb-6">
            RUNA
          </h1>
          <p className="text-neutral-400 text-lg font-light leading-relaxed">
            AI-powered merchant platform for fashion retail.
            Connect your store and let our AI agents automate
            visual merchandising, customer styling, and trend analysis.
          </p>
        </div>
      </div>

      {/* Right side - Form */}
      <div className="flex-1 flex items-center justify-center p-8 overflow-auto">
        <div className="w-full max-w-sm py-8">
          {/* Mobile logo */}
          <div className="lg:hidden mb-12">
            <h1 className="text-2xl font-light tracking-tight">RUNA</h1>
          </div>

          {/* Step indicator */}
          <div className="flex items-center gap-3 mb-8">
            <div className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium ${
              step >= 1 ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-400'
            }`}>
              1
            </div>
            <div className={`flex-1 h-px ${step >= 2 ? 'bg-neutral-900' : 'bg-neutral-200'}`}></div>
            <div className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium ${
              step >= 2 ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-400'
            }`}>
              2
            </div>
          </div>

          <div className="mb-10">
            <h2 className="text-xl font-light text-neutral-900">
              {step === 1 ? 'Create your account' : 'Connect your store'}
            </h2>
            <p className="text-sm text-neutral-500 mt-2">
              {step === 1 ? 'Step 1: Your details' : 'Step 2: Store information'}
            </p>
          </div>

          {error && (
            <div className="p-4 border border-red-200 bg-red-50 text-red-700 text-sm mb-6">
              {error}
            </div>
          )}

          {/* Step 1: Account Details */}
          {step === 1 && (
            <form onSubmit={handleNextStep} className="space-y-5">
              <div>
                <label className="label">Full Name</label>
                <input
                  type="text"
                  name="name"
                  className="input"
                  value={formData.name}
                  onChange={handleChange}
                  required
                  placeholder="John Doe"
                />
              </div>

              <div>
                <label className="label">Email</label>
                <input
                  type="email"
                  name="email"
                  className="input"
                  value={formData.email}
                  onChange={handleChange}
                  required
                  placeholder="you@company.com"
                />
              </div>

              <div>
                <label className="label">Password</label>
                <input
                  type="password"
                  name="password"
                  className="input"
                  value={formData.password}
                  onChange={handleChange}
                  required
                  minLength={6}
                  placeholder="Minimum 6 characters"
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary w-full mt-8"
              >
                Continue
              </button>
            </form>
          )}

          {/* Step 2: Store Details */}
          {step === 2 && (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="label">Store URL</label>
                <input
                  type="text"
                  name="storeUrl"
                  className="input"
                  value={formData.storeUrl}
                  onChange={handleChange}
                  required
                  placeholder="mystore.myshopify.com"
                />
              </div>

              <div>
                <label className="label">E-Commerce Platform</label>
                <select
                  name="platform"
                  className="input"
                  value={formData.platform}
                  onChange={handleChange}
                  required
                >
                  <option value="">Select platform</option>
                  {PLATFORMS.map((platform) => (
                    <option key={platform.value} value={platform.value}>
                      {platform.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* VTEX Credentials - only shown when VTEX is selected */}
              {formData.platform === 'vtex' && (
                <>
                  <div>
                    <label className="label">VTEX API Key</label>
                    <input
                      type="text"
                      name="vtexApiKey"
                      className="input"
                      value={formData.vtexApiKey}
                      onChange={handleChange}
                      required
                      placeholder="Your VTEX API Key"
                    />
                  </div>

                  <div>
                    <label className="label">VTEX Token</label>
                    <input
                      type="password"
                      name="vtexToken"
                      className="input"
                      value={formData.vtexToken}
                      onChange={handleChange}
                      required
                      placeholder="Your VTEX Token"
                    />
                  </div>
                </>
              )}

              <div className="flex gap-3 mt-8">
                <button
                  type="button"
                  onClick={handleBack}
                  className="btn btn-secondary flex-1"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="btn btn-primary flex-1"
                >
                  {loading ? (
                    <span className="flex items-center justify-center">
                      <span className="spinner mr-2"></span>
                      Creating
                    </span>
                  ) : (
                    'Create Account'
                  )}
                </button>
              </div>
            </form>
          )}

          <p className="mt-8 text-center text-sm text-neutral-500">
            Already have an account?{' '}
            <Link to="/login" className="link">
              Sign in
            </Link>
          </p>

          <p className="mt-8 text-center text-xs text-neutral-400 leading-relaxed">
            By creating an account, you agree to our Terms of Service and Privacy Policy
          </p>
        </div>
      </div>
    </div>
  );
}
