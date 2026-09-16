import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import { CheckCircle2, AlertTriangle, ShieldCheck, Mail, ArrowRight, KeyRound, Loader2, Sparkles } from 'lucide-react';

interface VerificationResult {
  valid: boolean;
  email?: string;
  name?: string;
  source?: string;
  requiresPassword?: boolean;
  reason?: string;
}

export const ActivatePage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') || '';

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Form fields for setting password
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');

  // Resend activation state
  const [resendEmail, setResendEmail] = useState('');
  const [resendLoading, setResendLoading] = useState(false);
  const [resendMessage, setResendMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setError('No activation token provided in the URL. Please check the link from your email.');
      return;
    }

    const verify = async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await api.verifyActivationToken(token);
        setVerification(res);
        if (res.email) {
          setResendEmail(res.email);
        }
      } catch (err: any) {
        setError(err.message || 'Invalid or expired activation link.');
      } finally {
        setLoading(false);
      }
    };

    verify();
  }, [token]);

  const handleActivate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setPasswordError('');

    if (verification?.requiresPassword) {
      if (!password) {
        setPasswordError('Password is required.');
        return;
      }
      if (password.length < 8) {
        setPasswordError('Password must be at least 8 characters long.');
        return;
      }
      if (!/[A-Z]/.test(password)) {
        setPasswordError('Password must contain at least one uppercase letter.');
        return;
      }
      if (!/[a-z]/.test(password)) {
        setPasswordError('Password must contain at least one lowercase letter.');
        return;
      }
      if (!/[0-9]/.test(password)) {
        setPasswordError('Password must contain at least one number.');
        return;
      }
      if (!/[^A-Za-z0-9]/.test(password)) {
        setPasswordError('Password must contain at least one special character.');
        return;
      }
      if (password !== confirmPassword) {
        setPasswordError('Passwords do not match.');
        return;
      }
    }

    try {
      setSubmitting(true);
      setError(null);
      await api.activateAccount(token, verification?.requiresPassword ? password : undefined);
      setSuccess(true);
    } catch (err: any) {
      setError(err.message || 'Account activation failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resendEmail) return;

    try {
      setResendLoading(true);
      setResendMessage(null);
      const res = await api.resendActivation(resendEmail);
      setResendMessage(res.message || 'Activation email sent. Please check your inbox.');
    } catch (err: any) {
      setResendMessage(err.message || 'Failed to resend activation email.');
    } finally {
      setResendLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center items-center p-4 selection:bg-indigo-500 selection:text-white">
      {/* Background glowing effects */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 left-1/3 w-80 h-80 bg-emerald-500/10 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-md bg-slate-900/90 backdrop-blur-xl border border-slate-800/80 rounded-2xl shadow-2xl p-6 sm:p-8">
        {/* Brand Header */}
        <div className="flex items-center justify-center gap-3 mb-6">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-tr from-indigo-600 to-indigo-400 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <ShieldCheck className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold bg-gradient-to-r from-white to-slate-300 bg-clip-text text-transparent">
              SafeBrowse
            </h1>
            <p className="text-xs text-slate-400 font-medium tracking-wide uppercase">Parent Portal Activation</p>
          </div>
        </div>

        {/* Loading State */}
        {loading && (
          <div className="py-12 flex flex-col items-center justify-center space-y-4">
            <Loader2 className="w-10 h-10 text-indigo-400 animate-spin" />
            <p className="text-sm text-slate-300">Verifying activation link security token...</p>
          </div>
        )}

        {/* Success State */}
        {!loading && success && (
          <div className="py-6 flex flex-col items-center text-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-lg shadow-emerald-500/10">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">Account Activated!</h2>
              <p className="text-sm text-slate-300 mt-2">
                Your parent account is now active and your email address is verified. You can sign in to configure your
                family dashboard and devices.
              </p>
            </div>
            <button
              onClick={() => navigate('/')}
              className="w-full mt-4 flex items-center justify-center gap-2 py-3 px-4 bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white font-medium rounded-xl shadow-lg shadow-indigo-500/25 transition-all duration-200 cursor-pointer"
            >
              <span>Continue to Sign In</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Verification Valid State */}
        {!loading && !success && verification?.valid && (
          <div>
            <div className="mb-6 text-center">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs font-semibold mb-3">
                <Sparkles className="w-3.5 h-3.5" />
                <span>Account Ready for Activation</span>
              </div>
              <h2 className="text-xl font-bold text-white">Welcome, {verification.name || 'Parent'}</h2>
              <p className="text-xs text-slate-400 mt-1 font-mono">{verification.email}</p>
            </div>

            {error && (
              <div className="mb-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {verification.requiresPassword ? (
              <form onSubmit={handleActivate} className="space-y-4">
                <div className="p-3 bg-slate-800/60 rounded-xl border border-slate-700/60 text-xs text-slate-300 space-y-1">
                  <p className="font-semibold text-white flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5 text-indigo-400" />
                    Set Your Password
                  </p>
                  <p className="text-slate-400">
                    Your account was provisioned by an administrator. Please set a strong password to complete
                    activation.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">New Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min 8 chars, Aa1@..."
                    className="w-full px-3.5 py-2.5 bg-slate-950/60 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">Confirm Password</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter password"
                    className="w-full px-3.5 py-2.5 bg-slate-950/60 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                    required
                  />
                </div>

                {passwordError && (
                  <p className="text-xs text-rose-400 font-medium">{passwordError}</p>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium rounded-xl shadow-lg shadow-indigo-600/20 flex items-center justify-center gap-2 transition-all cursor-pointer"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Activating Account...</span>
                    </>
                  ) : (
                    <>
                      <span>Set Password & Activate</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </form>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-slate-300 text-center">
                  Click below to activate your account and verify your email address.
                </p>

                <button
                  onClick={() => handleActivate()}
                  disabled={submitting}
                  className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium rounded-xl shadow-lg shadow-indigo-600/20 flex items-center justify-center gap-2 transition-all cursor-pointer"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Activating Account...</span>
                    </>
                  ) : (
                    <>
                      <span>Activate My Account</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Error / Invalid Token State */}
        {!loading && !success && (!verification || !verification.valid) && (
          <div className="space-y-6">
            <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-200 text-sm flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-rose-300">Activation Link Invalid or Expired</p>
                <p className="text-xs text-rose-200/80 mt-1">
                  {error || verification?.reason || 'The activation link you followed is no longer valid or has already been used.'}
                </p>
              </div>
            </div>

            {/* Resend Activation Form */}
            <div className="bg-slate-800/40 border border-slate-700/60 rounded-xl p-4">
              <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Mail className="w-3.5 h-3.5 text-indigo-400" />
                Resend Activation Link
              </h3>
              <p className="text-xs text-slate-400 mb-3">
                Enter your email address and we'll send a fresh activation link.
              </p>

              <form onSubmit={handleResend} className="space-y-3">
                <input
                  type="email"
                  value={resendEmail}
                  onChange={(e) => setResendEmail(e.target.value)}
                  placeholder="parent@example.com"
                  className="w-full px-3 py-2 bg-slate-950/80 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  required
                />

                {resendMessage && (
                  <p className="text-xs text-indigo-300 font-medium">{resendMessage}</p>
                )}

                <button
                  type="submit"
                  disabled={resendLoading}
                  className="w-full py-2 px-3 bg-slate-800 hover:bg-slate-700 border border-slate-600/60 rounded-lg text-xs font-medium text-white flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                >
                  {resendLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
                  <span>Send New Activation Link</span>
                </button>
              </form>
            </div>

            <div className="text-center">
              <Link to="/" className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors font-medium">
                Return to SafeBrowse Home
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
