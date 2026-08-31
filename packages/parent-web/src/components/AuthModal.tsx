import React, { useState } from 'react';
import { api } from '../api/client';
import { ShieldCheck, LogIn, UserPlus, Lock, Mail, User, KeyRound, ArrowLeft, CheckCircle2 } from 'lucide-react';

interface AuthModalProps {
  onSuccess: () => void;
}

type AuthMode = 'login' | 'register' | 'mfa_challenge' | 'forgot_password';

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setStatusMessage(null);
    setLoading(true);

    try {
      if (mode === 'register') {
        await api.register(email, password, name);
        onSuccess();
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
      }
    } catch (err: any) {
      setError(err.message || 'Authentication failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl max-w-md w-full p-8 shadow-2xl border border-slate-100 animate-fadeIn">
        {/* Brand Icon */}
        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-emerald-600 flex items-center justify-center text-white mx-auto shadow-lg shadow-emerald-600/25 mb-3">
            <ShieldCheck className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-black text-slate-900 tracking-tight">SafeBrowse</h2>
          <p className="text-xs text-slate-500 font-medium mt-1">
            {mode === 'register' && 'Create your parent account'}
            {mode === 'login' && 'Sign in to Parent Dashboard'}
            {mode === 'mfa_challenge' && 'Two-Factor Authentication Required'}
            {mode === 'forgot_password' && 'Reset your password'}
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 text-xs font-bold text-red-700">
            {error}
          </div>
        )}

        {statusMessage && (
          <div className="mb-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-bold text-emerald-700 flex items-center space-x-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{statusMessage}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'mfa_challenge' ? (
            <div>
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl mb-4 text-xs text-slate-600">
                {isRecoveryCode
                  ? 'Enter an 8-character single-use emergency recovery code (e.g. 8A3F-C29D).'
                  : 'Enter the 6-digit verification code from your authenticator app.'}
              </div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                {isRecoveryCode ? 'Recovery Code' : '6-Digit TOTP Code'}
              </label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                <input
                  type="text"
                  required
                  autoFocus
                  maxLength={isRecoveryCode ? 12 : 6}
                  placeholder={isRecoveryCode ? 'XXXX-XXXX' : '000000'}
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm font-mono tracking-widest text-center"
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
                  className="text-xs font-semibold text-emerald-600 hover:text-emerald-700 underline"
                >
                  {isRecoveryCode ? 'Use 6-digit Authenticator app code' : 'Lost phone? Use backup recovery code'}
                </button>
              </div>
            </div>
          ) : (
            <>
              {mode === 'register' && (
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                    Parent Name
                  </label>
                  <div className="relative">
                    <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                    <input
                      type="text"
                      required
                      placeholder="e.g. Sarah Miller"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm font-medium"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    type="email"
                    required
                    placeholder="parent@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm font-medium"
                  />
                </div>
              </div>

              {mode !== 'forgot_password' && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                      Password
                    </label>
                    {mode === 'login' && (
                      <button
                        type="button"
                        onClick={() => {
                          setMode('forgot_password');
                          setError(null);
                          setStatusMessage(null);
                        }}
                        className="text-xs text-slate-500 hover:text-emerald-600 font-medium"
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                    <input
                      type="password"
                      required
                      placeholder={mode === 'register' ? 'Min 15 characters (passphrase)' : '••••••••'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm font-medium"
                    />
                  </div>
                  {mode === 'register' && (
                    <p className="text-[11px] text-slate-400 mt-1">
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
            className="w-full py-3 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-sm shadow-md shadow-slate-900/20 flex items-center justify-center space-x-2 transition-all mt-2"
          >
            {mode === 'register' && <UserPlus className="w-4 h-4 text-emerald-400" />}
            {mode === 'login' && <LogIn className="w-4 h-4 text-emerald-400" />}
            {mode === 'mfa_challenge' && <KeyRound className="w-4 h-4 text-emerald-400" />}
            <span>
              {loading
                ? 'Please wait...'
                : mode === 'register'
                ? 'Create Account'
                : mode === 'mfa_challenge'
                ? 'Verify & Sign In'
                : mode === 'forgot_password'
                ? 'Send Reset Link'
                : 'Sign In to Dashboard'}
            </span>
          </button>
        </form>

        <div className="mt-4 text-center">
          {mode === 'mfa_challenge' || mode === 'forgot_password' ? (
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setError(null);
                setStatusMessage(null);
                setMfaTicket('');
                setMfaCode('');
              }}
              className="text-xs text-slate-500 hover:text-slate-900 font-semibold inline-flex items-center space-x-1"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Sign In</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'register' ? 'login' : 'register');
                setError(null);
                setStatusMessage(null);
              }}
              className="text-xs text-slate-500 hover:text-slate-900 font-semibold"
            >
              {mode === 'register' ? 'Already have an account? Sign In' : "Don't have an account? Create one"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
