import React, { useState } from 'react';
import { api } from '../api/client';
import { ShieldCheck, LogIn, UserPlus, Lock, Mail, User, KeyRound, ArrowLeft, CheckCircle2, Shield, Sparkles, ArrowRight, Download, Laptop } from 'lucide-react';

interface AuthModalProps {
  onSuccess: () => void;
}

type AuthMode = 'login' | 'register' | 'mfa_challenge' | 'forgot_password' | 'resend_activation';

export const AuthModal: React.FC<AuthModalProps> = ({ onSuccess }) => {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [mfaTicket, setMfaTicket] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [isRecoveryCode, setIsRecoveryCode] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);

  const showDemo = Boolean((import.meta as any).env?.DEV && (import.meta as any).env?.VITE_SHOW_DEMO_CREDENTIALS === 'true');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setStatusMessage(null);
    setLoading(true);

    try {
      if (mode === 'register') {
        const res = await api.register(email, password, name);
        setRegisteredEmail(email);
        setStatusMessage(
          res.message || 'Registration successful! Please check your email to activate your account.'
        );
      } else if (mode === 'login') {
        const res = await api.login(email, password);
        if (res.mfaRequired && res.mfaTicket) {
          setMfaTicket(res.mfaTicket);
          setMode('mfa_challenge');
        } else {
          onSuccess();
        }
      } else if (mode === 'mfa_challenge') {
        await api.mfaLogin(mfaTicket, mfaCode);
        onSuccess();
      } else if (mode === 'forgot_password') {
        const res = await api.forgotPassword(email);
        setStatusMessage(res.message || 'Password reset instructions have been sent to your email.');
      } else if (mode === 'resend_activation') {
        const res = await api.resendActivation(email);
        setStatusMessage(res.message || 'If an unactivated account exists, an activation link has been sent.');
      }
    } catch (err: any) {
      setError(err.message || 'Authentication failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleDemoLogin = async (demoEmail: string, demoPass: string) => {
    setEmail(demoEmail);
    setPassword(demoPass);
    setError(null);
    setStatusMessage(null);
    setLoading(true);

    try {
      const res = await api.login(demoEmail, demoPass);
      if (res.mfaRequired && res.mfaTicket) {
        setMfaTicket(res.mfaTicket);
        setMode('mfa_challenge');
      } else {
        onSuccess();
      }
    } catch (err: any) {
      setError(err.message || 'Login failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4 relative overflow-hidden selection:bg-emerald-500/30 selection:text-emerald-200">
      {/* Ambient background glows */}
      <div className="absolute top-1/4 -left-32 w-96 h-96 bg-emerald-600/15 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-purple-600/15 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full max-w-md relative z-10">
        {/* Main Glass Card */}
        <div className="glass-panel rounded-3xl p-8 shadow-2xl border border-slate-800/80 backdrop-blur-xl animate-fadeIn">
          {/* Brand Header */}
          <div className="text-center mb-6">
            <div className="inline-flex relative mb-3">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center text-slate-950 shadow-xl shadow-emerald-500/25 glow-emerald">
                <ShieldCheck className="w-9 h-9 text-slate-950" />
              </div>
              <div className="absolute -bottom-1 -right-1 bg-slate-900 border border-emerald-500/40 rounded-full p-1 text-emerald-400">
                <Sparkles className="w-3.5 h-3.5" />
              </div>
            </div>

            <h1 className="text-2xl font-black text-white tracking-tight flex items-center justify-center gap-2">
              SafeBrowse
            </h1>
            <p className="text-xs text-slate-400 font-medium mt-1">
              {registeredEmail && 'Please check your email to complete registration'}
              {!registeredEmail && mode === 'register' && 'Create your parent account for multi-device protection'}
              {!registeredEmail && mode === 'login' && 'Intelligent Child Web Protection & DNS Security Platform'}
              {!registeredEmail && mode === 'mfa_challenge' && 'Two-Factor Authentication Required'}
              {!registeredEmail && mode === 'forgot_password' && 'Enter your registered email to reset your password'}
              {!registeredEmail && mode === 'resend_activation' && 'Enter your registered email to receive a new activation link'}
            </p>
          </div>

          {error && (
            <div className="mb-4 p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs font-bold text-rose-300 animate-fadeIn">
              <p>{error}</p>
              {(error.toLowerCase().includes('activate your account') || error.toLowerCase().includes('activation')) && (
                <button
                  type="button"
                  onClick={() => {
                    setMode('resend_activation');
                    setError(null);
                    setStatusMessage(null);
                  }}
                  className="mt-2 text-xs text-emerald-400 hover:text-emerald-300 underline font-semibold block cursor-pointer"
                >
                  Click here to resend your activation email
                </button>
              )}
            </div>
          )}

          {statusMessage && (
            <div className="mb-4 p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs font-bold text-emerald-300 flex items-center space-x-2 animate-fadeIn">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{statusMessage}</span>
            </div>
          )}

          {registeredEmail ? (
            <div className="space-y-4 py-2">
              <div className="p-4 rounded-2xl bg-emerald-950/30 border border-emerald-500/30 text-center space-y-2">
                <div className="w-12 h-12 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mx-auto">
                  <Mail className="w-6 h-6" />
                </div>
                <h3 className="text-sm font-bold text-white">Activation Email Sent</h3>
                <p className="text-xs text-slate-300 leading-relaxed">
                  We've sent a secure activation link to <span className="font-mono text-emerald-300 font-semibold">{registeredEmail}</span>.
                  Please check your inbox and click the link to activate your account.
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  setRegisteredEmail(null);
                  setMode('login');
                  setError(null);
                  setStatusMessage(null);
                }}
                className="w-full py-3 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-medium text-sm border border-slate-700 transition cursor-pointer"
              >
                Return to Sign In
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {mode === 'mfa_challenge' ? (
                <div>
                  <div className="p-3 bg-slate-900/80 border border-slate-800 rounded-xl mb-4 text-xs text-slate-300">
                    {isRecoveryCode
                      ? 'Enter an 8-character single-use emergency recovery code (e.g. 8A3F-C29D).'
                      : 'Enter the 6-digit verification code from your authenticator app.'}
                  </div>
                  <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
                    {isRecoveryCode ? 'Recovery Code' : '6-Digit TOTP Code'}
                  </label>
                  <div className="relative">
                    <KeyRound className="w-4 h-4 text-slate-500 absolute left-3.5 top-3.5" />
                    <input
                      type="text"
                      required
                      autoFocus
                      maxLength={isRecoveryCode ? 12 : 6}
                      placeholder={isRecoveryCode ? 'XXXX-XXXX' : '000000'}
                      value={mfaCode}
                      onChange={(e) => setMfaCode(e.target.value)}
                      className="w-full pl-10 pr-4 py-3 rounded-xl bg-slate-900/90 border border-slate-700/80 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 text-sm font-mono tracking-widest text-center"
                    />
                  </div>

                  <div className="mt-3 text-center">
                    <button
                      type="button"
                      onClick={() => {
                        setIsRecoveryCode(!isRecoveryCode);
                        setMfaCode('');
                        setError(null);
                      }}
                      className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 underline cursor-pointer"
                    >
                      {isRecoveryCode ? 'Use 6-digit Authenticator app code' : 'Lost phone? Use backup recovery code'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {mode === 'register' && (
                    <div>
                      <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
                        Parent Name
                      </label>
                      <div className="relative">
                        <User className="w-4 h-4 text-slate-500 absolute left-3.5 top-3.5" />
                        <input
                          type="text"
                          required
                          placeholder="e.g. Sarah Miller"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-900/90 border border-slate-700/80 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 text-sm font-medium"
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
                      Email Address
                    </label>
                    <div className="relative">
                      <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-3.5" />
                      <input
                        type="email"
                        required
                        placeholder="parent@safebrowse.io"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-900/90 border border-slate-700/80 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 text-sm font-medium"
                      />
                    </div>
                  </div>

                  {mode !== 'forgot_password' && mode !== 'resend_activation' && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                          Password
                        </label>
                        {mode === 'login' && (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setMode('forgot_password');
                                setError(null);
                                setStatusMessage(null);
                              }}
                              className="text-xs text-slate-400 hover:text-emerald-400 font-medium transition cursor-pointer"
                            >
                              Forgot password?
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="relative">
                        <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-3.5" />
                        <input
                          type="password"
                          required
                          placeholder={mode === 'register' ? 'Min 15 characters (passphrase)' : '••••••••'}
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-900/90 border border-slate-700/80 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 text-sm font-medium"
                        />
                      </div>
                      {mode === 'register' && (
                        <p className="text-[11px] text-slate-500 mt-1">
                          NIST 800-63B compliant: Minimum 15 characters. Passphrases with spaces supported.
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-sm shadow-lg shadow-emerald-500/20 flex items-center justify-center space-x-2 transition-all mt-3 cursor-pointer disabled:opacity-50"
              >
                {mode === 'register' && <UserPlus className="w-4 h-4" />}
                {mode === 'login' && <LogIn className="w-4 h-4" />}
                {mode === 'mfa_challenge' && <KeyRound className="w-4 h-4" />}
                {mode === 'resend_activation' && <Mail className="w-4 h-4" />}
                <span>
                  {loading
                    ? 'Processing...'
                    : mode === 'register'
                    ? 'Create Parent Account'
                    : mode === 'mfa_challenge'
                    ? 'Verify & Sign In'
                    : mode === 'forgot_password'
                    ? 'Send Reset Link'
                    : mode === 'resend_activation'
                    ? 'Resend Activation Link'
                    : 'Sign In'}
                </span>
              </button>
            </form>
          )}

          {/* 1-Click Demo Account Quick Access - STRICTLY GATED TO DEV */}
          {mode === 'login' && !registeredEmail && showDemo && (
            <div className="mt-6 pt-5 border-t border-slate-800/80">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  <span>Instant 1-Click Demo</span>
                </span>
                <span className="text-[10px] bg-slate-800 text-slate-300 border border-slate-700/80 px-2 py-0.5 rounded-full font-semibold">
                  Pre-configured
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {/* Parent Demo Button */}
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => handleDemoLogin('parent@safebrowse.io', 'Password123!')}
                  className="text-left p-3.5 rounded-2xl bg-gradient-to-b from-emerald-950/40 to-slate-900 border border-emerald-500/30 hover:border-emerald-400 hover:shadow-lg hover:shadow-emerald-500/10 transition-all group cursor-pointer disabled:opacity-50"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-black text-emerald-300 flex items-center gap-1">
                      Parent Portal
                    </span>
                    <span className="text-[9px] font-bold text-emerald-400 bg-emerald-500/20 border border-emerald-500/30 px-1.5 py-0.5 rounded-md flex items-center gap-0.5 group-hover:bg-emerald-500 group-hover:text-slate-950 transition">
                      SIGN IN <ArrowRight className="w-2.5 h-2.5" />
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-300 font-mono font-semibold truncate">parent@safebrowse.io</div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">Password123!</div>
                </button>

                {/* System Admin Demo Button */}
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => handleDemoLogin('admin@safebrowse.io', 'Password123!')}
                  className="text-left p-3.5 rounded-2xl bg-gradient-to-b from-purple-950/40 to-slate-900 border border-purple-500/30 hover:border-purple-400 hover:shadow-lg hover:shadow-purple-500/10 transition-all group cursor-pointer disabled:opacity-50"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-black text-purple-300 flex items-center gap-1">
                      Admin Portal
                    </span>
                    <span className="text-[9px] font-bold text-purple-400 bg-purple-500/20 border border-purple-500/30 px-1.5 py-0.5 rounded-md flex items-center gap-0.5 group-hover:bg-purple-500 group-hover:text-slate-950 transition">
                      SIGN IN <ArrowRight className="w-2.5 h-2.5" />
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-300 font-mono font-semibold truncate">admin@safebrowse.io</div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">Password123!</div>
                </button>
              </div>
            </div>
          )}

          {/* Mode Switcher */}
          {!registeredEmail && (
            <div className="mt-5 text-center space-y-2">
              {mode === 'mfa_challenge' || mode === 'forgot_password' || mode === 'resend_activation' ? (
                <button
                  type="button"
                  onClick={() => {
                    setMode('login');
                    setError(null);
                    setStatusMessage(null);
                    setMfaTicket('');
                    setMfaCode('');
                  }}
                  className="text-xs text-slate-400 hover:text-white font-semibold inline-flex items-center space-x-1.5 cursor-pointer transition"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Back to Sign In</span>
                </button>
              ) : (
                <div className="flex flex-col gap-1.5 items-center">
                  <button
                    type="button"
                    onClick={() => {
                      setMode(mode === 'register' ? 'login' : 'register');
                      setError(null);
                      setStatusMessage(null);
                    }}
                    className="text-xs text-slate-400 hover:text-emerald-400 font-semibold cursor-pointer transition"
                  >
                    {mode === 'register' ? 'Already have an account? Sign In' : "Don't have an account? Create one"}
                  </button>

                  {mode === 'login' && (
                    <button
                      type="button"
                      onClick={() => {
                        setMode('resend_activation');
                        setError(null);
                        setStatusMessage(null);
                      }}
                      className="text-[11px] text-slate-500 hover:text-slate-300 font-medium cursor-pointer transition"
                    >
                      Need to resend activation link?
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Download Windows Child Protection App */}
          <div className="mt-6 pt-5 border-t border-slate-800/80">
            <div className="text-center mb-3">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center justify-center gap-1.5">
                <Download className="w-3.5 h-3.5 text-indigo-400" />
                <span>Windows Child Protection App</span>
              </span>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Install on child's device, then connect with your parent account
              </p>
            </div>

            <div className="flex justify-center">
              <a
                href="/api/downloads/windows"
                download="SafeBrowseChild-Pilot.msi"
                className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-gradient-to-r from-indigo-950/40 via-slate-900 to-indigo-950/30 border border-indigo-500/30 hover:border-indigo-400 hover:shadow-lg hover:shadow-indigo-500/10 transition-all group cursor-pointer"
                title="Download SafeBrowse Child Protection MSI Installer for Windows 10/11"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0 group-hover:scale-105 transition-transform">
                    <Laptop className="w-5 h-5" />
                  </div>
                  <div className="text-left">
                    <div className="text-xs font-bold text-white group-hover:text-indigo-300 transition">
                      Download for Windows
                    </div>
                    <div className="text-[10px] text-slate-400">
                      Windows 10/11 64-bit
                    </div>
                  </div>
                </div>
                <span className="text-[10px] font-bold text-indigo-300 bg-indigo-500/20 px-3 py-1.5 rounded-xl border border-indigo-500/30 group-hover:bg-indigo-500 group-hover:text-slate-950 transition flex items-center gap-1.5 shrink-0">
                  <Download className="w-3 h-3" />
                  <span>Get Installer (.msi)</span>
                </span>
              </a>
            </div>
          </div>
        </div>

        {/* Footnote */}
        <div className="mt-4 text-center text-[11px] text-slate-500">
          SafeBrowse Enterprise Core • Green Code Request Deduplication Enabled
        </div>
      </div>
    </div>
  );
};
