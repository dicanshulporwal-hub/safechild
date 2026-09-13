import React, { useState, useEffect } from 'react';

interface ParentProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface UserProfile {
  id: string;
  email: string;
  name: string;
  mobileNumber?: string;
  timezone: string;
  language: string;
  notificationPrefs: {
    emailAlerts: boolean;
    pushNotifications: boolean;
    requestAlerts: boolean;
    tamperAlerts: boolean;
    weeklySummary: boolean;
  };
  mfaEnabled: boolean;
  lastLoginAt?: string;
  createdAt: string;
  familyRole: string;
  familyName: string;
}

interface UserSessionItem {
  id: string;
  deviceInfo: string;
  ipAddress?: string;
  createdAt: string;
  lastSeenAt: string;
  isCurrent: boolean;
}

export const ParentProfileModal: React.FC<ParentProfileModalProps> = ({ isOpen, onClose }) => {
  const [tab, setTab] = useState<'profile' | 'security' | 'mfa' | 'sessions'>('profile');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<{ text: string; isError?: boolean } | null>(null);

  // Form states
  const [name, setName] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [language, setLanguage] = useState('en-US');
  const [notificationPrefs, setNotificationPrefs] = useState({
    emailAlerts: true,
    pushNotifications: true,
    requestAlerts: true,
    tamperAlerts: true,
    weeklySummary: true,
  });

  // Password change states
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // MFA states
  const [mfaSetupData, setMfaSetupData] = useState<{ secret: string; otpAuthUrl: string; qrPlaceholder: string } | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [disableMfaPassword, setDisableMfaPassword] = useState('');
  const [showDisableMfa, setShowDisableMfa] = useState(false);

  // Sessions state
  const [sessions, setSessions] = useState<UserSessionItem[]>([]);

  const token = localStorage.getItem('safebrowse_token');

  useEffect(() => {
    if (isOpen) {
      fetchProfile();
      fetchSessions();
      setStatusMsg(null);
    }
  }, [isOpen]);

  const fetchProfile = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setProfile(data);
        setName(data.name);
        setMobileNumber(data.mobileNumber || '');
        setTimezone(data.timezone);
        setLanguage(data.language);
        if (data.notificationPrefs) setNotificationPrefs(data.notificationPrefs);
      }
    } catch (e) {}
    setLoading(false);
  };

  const fetchSessions = async () => {
    try {
      const res = await fetch('/api/me/sessions', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } catch (e) {}
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await fetch('/api/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name,
          mobileNumber,
          timezone,
          language,
          notificationPrefs,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setProfile(data);
        setStatusMsg({ text: 'Profile updated successfully!' });
      } else {
        setStatusMsg({ text: data.error || 'Failed to update profile', isError: true });
      }
    } catch (e: any) {
      setStatusMsg({ text: e.message, isError: true });
    }
    setSaving(false);
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setStatusMsg({ text: 'New passwords do not match.', isError: true });
      return;
    }
    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await fetch('/api/me/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatusMsg({ text: 'Password updated successfully! Other active sessions were signed out.' });
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        fetchSessions();
      } else {
        setStatusMsg({ text: data.error || 'Failed to update password', isError: true });
      }
    } catch (e: any) {
      setStatusMsg({ text: e.message, isError: true });
    }
    setSaving(false);
  };

  const startMfaSetup = async () => {
    setStatusMsg(null);
    try {
      const res = await fetch('/api/me/mfa/setup', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setMfaSetupData(data);
      }
    } catch (e) {}
  };

  const verifyMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMsg(null);
    setSaving(true);
    try {
      const res = await fetch('/api/me/mfa/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ otpCode }),
      });
      const data = await res.json();
      if (res.ok) {
        setRecoveryCodes(data.recoveryCodes || []);
        setMfaSetupData(null);
        setOtpCode('');
        fetchProfile();
        setStatusMsg({ text: 'Multi-Factor Authentication enabled successfully!' });
      } else {
        setStatusMsg({ text: data.error || 'Failed to verify OTP code', isError: true });
      }
    } catch (e: any) {
      setStatusMsg({ text: e.message, isError: true });
    }
    setSaving(false);
  };

  const disableMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMsg(null);
    setSaving(true);
    try {
      const res = await fetch('/api/me/mfa/disable', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ password: disableMfaPassword }),
      });
      const data = await res.json();
      if (res.ok) {
        setShowDisableMfa(false);
        setDisableMfaPassword('');
        fetchProfile();
        setStatusMsg({ text: 'MFA has been disabled.' });
      } else {
        setStatusMsg({ text: data.error || 'Failed to disable MFA', isError: true });
      }
    } catch (e: any) {
      setStatusMsg({ text: e.message, isError: true });
    }
    setSaving(false);
  };

  const revokeSession = async (sessionId: string) => {
    try {
      const res = await fetch(`/api/me/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        fetchSessions();
        setStatusMsg({ text: 'Session terminated.' });
      }
    } catch (e) {}
  };

  const revokeOtherSessions = async () => {
    try {
      const res = await fetch('/api/me/sessions/revoke-others', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        fetchSessions();
        setStatusMsg({ text: 'All other sessions have been signed out.' });
      }
    } catch (e) {}
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fadeIn">
      <div className="bg-slate-900 border border-slate-750 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-slate-800 bg-slate-900/80">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-lg">
              👤
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">Parent Account & Profile</h2>
              <p className="text-xs text-slate-400">Manage identity, credentials, MFA and security sessions</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg p-2 rounded-lg hover:bg-slate-800 transition">
            ✕
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 bg-slate-950/40 px-6 gap-2 pt-2">
          {[
            { id: 'profile', label: '👤 Profile', count: undefined },
            { id: 'security', label: '🔒 Password', count: undefined },
            { id: 'mfa', label: '🛡️ MFA', badge: profile?.mfaEnabled ? 'ON' : undefined },
            { id: 'sessions', label: '💻 Sessions', count: sessions.length },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => { setTab(t.id as any); setStatusMsg(null); }}
              className={`pb-3 px-3 text-sm font-semibold border-b-2 transition flex items-center gap-2 ${
                tab === t.id
                  ? 'border-indigo-500 text-indigo-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>{t.label}</span>
              {t.badge && (
                <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded font-mono font-bold">
                  {t.badge}
                </span>
              )}
              {t.count !== undefined && (
                <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded-full font-mono">
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Status Message */}
        {statusMsg && (
          <div className={`mx-6 mt-4 p-3 rounded-lg text-sm flex items-center gap-2 ${
            statusMsg.isError ? 'bg-rose-500/10 border border-rose-500/30 text-rose-300' : 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
          }`}>
            <span>{statusMsg.isError ? '⚠️' : '✅'}</span>
            <span>{statusMsg.text}</span>
          </div>
        )}

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-6">
          {loading ? (
            <div className="py-12 text-center text-slate-400">Loading account details...</div>
          ) : (
            <>
              {/* TAB 1: Profile */}
              {tab === 'profile' && (
                <form onSubmit={handleSaveProfile} className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">Full Name</label>
                      <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        required
                        className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">Email Address</label>
                      <input
                        type="email"
                        value={profile?.email || ''}
                        disabled
                        className="w-full bg-slate-800/40 border border-slate-800 rounded-lg px-3 py-2 text-slate-400 cursor-not-allowed"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">Mobile Number (Optional)</label>
                      <input
                        type="tel"
                        value={mobileNumber}
                        onChange={(e) => setMobileNumber(e.target.value)}
                        placeholder="+1 (555) 000-0000"
                        className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">Timezone</label>
                      <select
                        value={timezone}
                        onChange={(e) => setTimezone(e.target.value)}
                        className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500"
                      >
                        <option value="America/New_York">Eastern Time (US & Canada)</option>
                        <option value="America/Chicago">Central Time (US & Canada)</option>
                        <option value="America/Denver">Mountain Time (US & Canada)</option>
                        <option value="America/Los_Angeles">Pacific Time (US & Canada)</option>
                        <option value="Europe/London">London (GMT)</option>
                        <option value="Europe/Paris">Central European Time (CET)</option>
                        <option value="Asia/Kolkata">India Standard Time (IST)</option>
                        <option value="Asia/Tokyo">Japan Standard Time (JST)</option>
                        <option value="UTC">UTC Universal</option>
                      </select>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-800">
                    <h3 className="text-sm font-semibold text-white mb-2">Notification Preferences</h3>
                    <div className="space-y-2">
                      {[
                        { key: 'requestAlerts', label: 'Instant Ask Parent Requests', desc: 'Notify immediately when child requests website unlock' },
                        { key: 'tamperAlerts', label: 'Security & Tamper Alerts', desc: 'Notify if VPN disconnected or uninstalled' },
                        { key: 'emailAlerts', label: 'Important Email Summaries', desc: 'Security login notifications and password alerts' },
                      ].map((pref) => (
                        <label key={pref.key} className="flex items-start gap-3 p-2 rounded-lg hover:bg-slate-800/50 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={(notificationPrefs as any)[pref.key]}
                            onChange={(e) =>
                              setNotificationPrefs({
                                ...notificationPrefs,
                                [pref.key]: e.target.checked,
                              })
                            }
                            className="mt-1 rounded bg-slate-800 border-slate-700 text-indigo-600 focus:ring-indigo-500"
                          />
                          <div>
                            <div className="text-sm font-medium text-slate-200">{pref.label}</div>
                            <div className="text-xs text-slate-400">{pref.desc}</div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="flex justify-end pt-4">
                    <button
                      type="submit"
                      disabled={saving}
                      className="px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition shadow-lg shadow-indigo-600/30 disabled:opacity-50"
                    >
                      {saving ? 'Saving...' : 'Save Profile Changes'}
                    </button>
                  </div>
                </form>
              )}

              {/* TAB 2: Change Password */}
              {tab === 'security' && (
                <form onSubmit={handleChangePassword} className="space-y-4 max-w-md">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">Current Password</label>
                    <input
                      type="password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      required
                      placeholder="••••••••••••"
                      className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">New Password (Min 8 chars)</label>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                      minLength={8}
                      placeholder="••••••••••••"
                      className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">Confirm New Password</label>
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      minLength={8}
                      placeholder="••••••••••••"
                      className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <p className="text-xs text-slate-400">
                    ℹ️ Changing your password will automatically sign out all other devices and active web sessions for account security.
                  </p>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition shadow-lg shadow-indigo-600/30 disabled:opacity-50"
                  >
                    {saving ? 'Updating...' : 'Update Password'}
                  </button>
                </form>
              )}

              {/* TAB 3: MFA */}
              {tab === 'mfa' && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between p-4 bg-slate-800/60 border border-slate-700 rounded-xl">
                    <div className="flex items-center gap-3">
                      <div className="text-2xl">{profile?.mfaEnabled ? '🛡️' : '⚪'}</div>
                      <div>
                        <div className="font-semibold text-white flex items-center gap-2">
                          Authenticator App (TOTP)
                          {profile?.mfaEnabled ? (
                            <span className="text-xs bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full font-bold">ACTIVE</span>
                          ) : (
                            <span className="text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full font-bold">DISABLED</span>
                          )}
                        </div>
                        <p className="text-xs text-slate-400">
                          Protect your account using Google Authenticator, Microsoft Authenticator, or 1Password.
                        </p>
                      </div>
                    </div>

                    {profile?.mfaEnabled ? (
                      <button
                        onClick={() => setShowDisableMfa(true)}
                        className="px-3 py-1.5 text-xs font-semibold text-rose-400 hover:text-rose-300 border border-rose-500/30 rounded-lg hover:bg-rose-500/10 transition"
                      >
                        Disable MFA
                      </button>
                    ) : (
                      <button
                        onClick={startMfaSetup}
                        className="px-4 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition shadow-md shadow-emerald-600/20"
                      >
                        Setup Authenticator
                      </button>
                    )}
                  </div>

                  {/* Setup Wizard */}
                  {mfaSetupData && (
                    <div className="p-4 bg-slate-800/80 border border-indigo-500/40 rounded-xl space-y-4 animate-fadeIn">
                      <h4 className="text-sm font-bold text-white">Scan QR Code in Authenticator</h4>
                      <div className="flex flex-col sm:flex-row items-center gap-6">
                        <img
                          src={mfaSetupData.qrPlaceholder}
                          alt="MFA QR Code"
                          className="w-36 h-36 bg-white p-2 rounded-lg shadow"
                        />
                        <div className="space-y-3 flex-1">
                          <p className="text-xs text-slate-300">
                            1. Open your authenticator app and scan the QR code.
                          </p>
                          <p className="text-xs text-slate-400">
                            Or enter secret key manually: <code className="bg-slate-900 px-2 py-1 rounded text-indigo-300 font-mono select-all">{mfaSetupData.secret}</code>
                          </p>
                          <form onSubmit={verifyMfa} className="flex gap-2">
                            <input
                              type="text"
                              maxLength={6}
                              value={otpCode}
                              onChange={(e) => setOtpCode(e.target.value)}
                              placeholder="000000"
                              required
                              className="w-32 text-center text-lg tracking-widest bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-white font-mono focus:outline-none focus:border-emerald-500"
                            />
                            <button
                              type="submit"
                              disabled={saving || otpCode.length !== 6}
                              className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg transition disabled:opacity-50"
                            >
                              Verify & Activate
                            </button>
                          </form>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Recovery Codes Display */}
                  {recoveryCodes.length > 0 && (
                    <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl space-y-3 animate-fadeIn">
                      <div className="flex items-center gap-2 text-amber-300 font-semibold text-sm">
                        <span>⚠️</span>
                        <span>Save Your One-Time Recovery Codes</span>
                      </div>
                      <p className="text-xs text-slate-300">
                        If you lose access to your authenticator app, you can use these single-use codes to log into your account. Store them in a secure place.
                      </p>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-slate-950/60 p-3 rounded-lg border border-slate-800">
                        {recoveryCodes.map((code, idx) => (
                          <div key={idx} className="font-mono text-xs text-indigo-300 text-center select-all py-1">
                            {code}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Disable MFA Modal */}
                  {showDisableMfa && (
                    <form onSubmit={disableMfa} className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl space-y-3">
                      <h4 className="text-sm font-bold text-rose-300">Disable Multi-Factor Authentication</h4>
                      <p className="text-xs text-slate-300">
                        Please confirm your account password to remove MFA protection:
                      </p>
                      <div className="flex gap-2">
                        <input
                          type="password"
                          value={disableMfaPassword}
                          onChange={(e) => setDisableMfaPassword(e.target.value)}
                          placeholder="Password"
                          required
                          className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none"
                        />
                        <button
                          type="submit"
                          disabled={saving}
                          className="px-4 py-1.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-lg transition"
                        >
                          Confirm Disable
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowDisableMfa(false)}
                          className="px-3 py-1.5 text-xs text-slate-400 hover:text-white"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              )}

              {/* TAB 4: Sessions */}
              {tab === 'sessions' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-white">Active Parent Sessions</h3>
                      <p className="text-xs text-slate-400">Review all devices currently signed in to your parent account</p>
                    </div>
                    {sessions.length > 1 && (
                      <button
                        onClick={revokeOtherSessions}
                        className="px-3 py-1.5 text-xs font-medium text-rose-400 hover:text-rose-300 border border-rose-500/30 rounded-lg hover:bg-rose-500/10 transition"
                      >
                        Sign Out All Other Devices
                      </button>
                    )}
                  </div>

                  <div className="space-y-2">
                    {sessions.map((sess) => (
                      <div
                        key={sess.id}
                        className={`p-3 rounded-xl border flex items-center justify-between ${
                          sess.isCurrent
                            ? 'bg-indigo-500/10 border-indigo-500/30'
                            : 'bg-slate-800/40 border-slate-800'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className="text-xl">{sess.deviceInfo.includes('Mobile') ? '📱' : '💻'}</div>
                          <div>
                            <div className="text-sm font-medium text-white flex items-center gap-2">
                              <span>{sess.deviceInfo}</span>
                              {sess.isCurrent && (
                                <span className="text-[10px] bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded font-bold">
                                  Current Session
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-slate-400">
                              First signed in: {new Date(sess.createdAt).toLocaleDateString()}
                            </div>
                          </div>
                        </div>

                        {!sess.isCurrent && (
                          <button
                            onClick={() => revokeSession(sess.id)}
                            className="text-xs text-slate-400 hover:text-rose-400 px-2 py-1 rounded hover:bg-slate-800 transition"
                          >
                            Sign Out
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
