import React, { useState, useEffect } from 'react';
import { useToast } from '../components/Toast';
import { api } from '../api/client';

interface UserSessionItem {
  id: string;
  deviceInfo: string;
  ipAddress?: string;
  createdAt: string;
  lastSeenAt: string;
  isCurrent: boolean;
}

export const SecuritySettingsPage: React.FC = () => {
  const { showToast } = useToast();
  const [profile, setProfile] = useState<any>(null);
  const [sessions, setSessions] = useState<UserSessionItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  // MFA states
  const [mfaSetupData, setMfaSetupData] = useState<{ secret: string; otpAuthUrl: string; qrDataUrl?: string; qrPlaceholder?: string } | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [disableMfaPassword, setDisableMfaPassword] = useState('');
  const [showDisableMfa, setShowDisableMfa] = useState(false);
  const [activatingMfa, setActivatingMfa] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [prof, sessData] = await Promise.all([
        api.getProfile().catch(() => null),
        api.getSessions().catch(() => ({ sessions: [] })),
      ]);
      if (prof) setProfile(prof);
      if (sessData) setSessions(sessData.sessions || []);
    } catch (e) {
      console.error('Error loading security data:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      showToast('New passwords do not match.', 'error');
      return;
    }
    setSavingPassword(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      showToast('Password successfully changed! Other sessions signed out.', 'success');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      fetchData();
    } catch (e: any) {
      showToast(e.message || 'Failed to update password', 'error');
    } finally {
      setSavingPassword(false);
    }
  };

  const startMfaSetup = async () => {
    try {
      const data = await api.setupMfa();
      setMfaSetupData(data);
    } catch (e: any) {
      showToast(e.message || 'Failed to initialize MFA setup', 'error');
    }
  };

  const verifyMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    setActivatingMfa(true);
    try {
      const data = await api.verifyMfa(otpCode);
      setRecoveryCodes(data.recoveryCodes || []);
      setMfaSetupData(null);
      setOtpCode('');
      fetchData();
      showToast('MFA enabled successfully! Save your recovery codes below.', 'success');
    } catch (e: any) {
      showToast(e.message || 'Failed to verify code', 'error');
    } finally {
      setActivatingMfa(false);
    }
  };

  const disableMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.disableMfa(disableMfaPassword);
      setShowDisableMfa(false);
      setDisableMfaPassword('');
      fetchData();
      showToast('Multi-Factor Authentication disabled.', 'info');
    } catch (e: any) {
      showToast(e.message || 'Failed to disable MFA', 'error');
    }
  };

  const handleRevokeSession = async (id: string) => {
    try {
      await api.revokeSession(id);
      showToast('Session revoked.', 'info');
      fetchData();
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleRevokeOtherSessions = async () => {
    try {
      await api.revokeOtherSessions();
      showToast('All other sessions signed out.', 'success');
      fetchData();
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-slate-400">Loading security settings...</div>;
  }

  return (
    <div className="max-w-4xl space-y-8 animate-fadeIn">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-extrabold text-white tracking-tight">Security & Active Sessions</h1>
        <p className="text-xs text-slate-400">Manage account passwords, 2-Factor Authentication, recovery codes, and active devices</p>
      </div>

      {/* Section 1: Change Password */}
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-xl">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div>
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">Account Password</h2>
            <p className="text-xs text-slate-400">Update your login password. All other web sessions will be signed out automatically.</p>
          </div>
          <span className="text-xs text-emerald-400 font-mono bg-emerald-500/10 px-2 py-1 rounded border border-emerald-500/20">
            Bcrypt Hashed
          </span>
        </div>

        <form onSubmit={handleChangePassword} className="space-y-4 max-w-md">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase mb-1">Current Password</label>
            <input
              type="password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="••••••••••••"
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase mb-1">New Password (Min 8)</label>
              <input
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase mb-1">Confirm New Password</label>
              <input
                type="password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={savingPassword}
            className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition shadow-md shadow-emerald-600/20 disabled:opacity-50"
          >
            {savingPassword ? 'Updating Password...' : 'Update Password'}
          </button>
        </form>
      </section>

      {/* Section 2: Multi-Factor Authentication */}
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5 shadow-xl">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div>
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">Multi-Factor Authentication (MFA)</h2>
            <p className="text-xs text-slate-400">Protect account access using Authenticator Apps (Google Authenticator, Microsoft Authenticator, 1Password)</p>
          </div>
          {profile?.mfaEnabled ? (
            <span className="text-xs bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2.5 py-1 rounded-full font-bold">
              🟢 ACTIVE
            </span>
          ) : (
            <span className="text-xs bg-slate-800 text-slate-400 px-2.5 py-1 rounded-full font-bold">
              DISABLED
            </span>
          )}
        </div>

        {!profile?.mfaEnabled ? (
          <div className="space-y-4">
            <p className="text-xs text-slate-300">
              When enabled, signing in requires your account password plus a 6-digit verification code from your authenticator app.
            </p>
            {!mfaSetupData ? (
              <button
                onClick={startMfaSetup}
                className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition shadow-lg shadow-emerald-600/20"
              >
                Set Up Authenticator App
              </button>
            ) : (
              <div className="bg-slate-950 p-5 rounded-xl border border-indigo-500/30 space-y-4 animate-fadeIn">
                <h3 className="text-xs font-bold uppercase text-indigo-400">Step-by-Step MFA Setup</h3>
                <div className="flex flex-col md:flex-row items-center gap-6">
                  <img
                    src={mfaSetupData.qrDataUrl || mfaSetupData.qrPlaceholder}
                    alt="MFA QR Code"
                    className="w-36 h-36 bg-white p-2 rounded-xl shadow"
                  />
                  <div className="space-y-3 flex-1">
                    <p className="text-xs text-slate-300">
                      1. Open your authenticator app and scan the QR code.
                    </p>
                    <p className="text-xs text-slate-400">
                      Or enter secret manually: <code className="bg-slate-900 px-2 py-1 rounded text-indigo-300 font-mono select-all text-xs">{mfaSetupData.secret}</code>
                    </p>
                    <form onSubmit={verifyMfa} className="flex gap-2">
                      <input
                        type="text"
                        maxLength={6}
                        required
                        value={otpCode}
                        onChange={(e) => setOtpCode(e.target.value)}
                        placeholder="000000"
                        className="w-32 text-center text-lg tracking-widest bg-slate-900 border border-slate-700 rounded-xl px-3 py-1.5 text-white font-mono focus:outline-none focus:border-emerald-500"
                      />
                      <button
                        type="submit"
                        disabled={activatingMfa || otpCode.length !== 6}
                        className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition disabled:opacity-50"
                      >
                        {activatingMfa ? 'Verifying...' : 'Verify & Enable MFA'}
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-xl">
              <div>
                <div className="text-sm font-bold text-white">Authenticator App is Active</div>
                <div className="text-xs text-slate-300">Your parent account is verified with 2-Factor Authentication on every login.</div>
              </div>
              <button
                onClick={() => setShowDisableMfa(!showDisableMfa)}
                className="px-3.5 py-1.5 text-xs font-bold text-rose-400 hover:text-rose-300 border border-rose-500/30 rounded-lg hover:bg-rose-500/10 transition"
              >
                Disable MFA
              </button>
            </div>

            {showDisableMfa && (
              <form onSubmit={disableMfa} className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl space-y-3">
                <h4 className="text-xs font-bold text-rose-300 uppercase">Confirm Password to Disable MFA</h4>
                <div className="flex gap-2">
                  <input
                    type="password"
                    required
                    value={disableMfaPassword}
                    onChange={(e) => setDisableMfaPassword(e.target.value)}
                    placeholder="Account Password"
                    className="bg-slate-950 border border-slate-700 rounded-xl px-3 py-1.5 text-white text-xs flex-1"
                  />
                  <button
                    type="submit"
                    className="px-4 py-1.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl transition"
                  >
                    Confirm Disable
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        {/* Recovery Codes Display */}
        {recoveryCodes.length > 0 && (
          <div className="p-5 bg-amber-500/10 border border-amber-500/30 rounded-xl space-y-3 animate-fadeIn">
            <div className="flex items-center gap-2 text-amber-300 font-bold text-sm">
              <span>⚠️</span>
              <span>Save Your One-Time Recovery Codes</span>
            </div>
            <p className="text-xs text-slate-300">
              If you lose your authenticator device, you can use these single-use codes to access your account. Store them securely.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-slate-950/80 p-3 rounded-lg border border-slate-800">
              {recoveryCodes.map((c, i) => (
                <div key={i} className="font-mono text-xs text-indigo-300 text-center py-1 select-all">
                  {c}
                </div>
              ))}
            </div>
            <button
              onClick={() => {
                navigator.clipboard.writeText(recoveryCodes.join('\n'));
                showToast('Recovery codes copied to clipboard!', 'success');
              }}
              className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold rounded-lg transition"
            >
              Copy All Codes
            </button>
          </div>
        )}
      </section>

      {/* Section 3: Active Sessions */}
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-xl">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div>
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">Active Device Sessions</h2>
            <p className="text-xs text-slate-400">Devices currently authenticated to your parent account</p>
          </div>
          {sessions.length > 1 && (
            <button
              onClick={handleRevokeOtherSessions}
              className="px-3 py-1.5 text-xs font-semibold text-rose-400 hover:text-rose-300 border border-rose-500/30 rounded-lg hover:bg-rose-500/10 transition"
            >
              Sign Out All Other Devices
            </button>
          )}
        </div>

        <div className="space-y-2">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`p-3.5 rounded-xl border flex items-center justify-between ${
                s.isCurrent ? 'bg-indigo-500/10 border-indigo-500/30' : 'bg-slate-950/50 border-slate-800'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className="text-2xl">{s.deviceInfo?.includes('Mobile') ? '📱' : '💻'}</div>
                <div>
                  <div className="text-sm font-bold text-white flex items-center gap-2">
                    <span>{s.deviceInfo}</span>
                    {s.isCurrent && (
                      <span className="text-[10px] bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded-full font-bold">
                        CURRENT DEVICE
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-400">
                    Created: {new Date(s.createdAt || Date.now()).toLocaleDateString()} • Last active: {new Date(s.lastSeenAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>

              {!s.isCurrent && (
                <button
                  onClick={() => handleRevokeSession(s.id)}
                  className="text-xs font-semibold text-slate-400 hover:text-rose-400 px-3 py-1 rounded hover:bg-slate-800 transition"
                >
                  Sign Out
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
