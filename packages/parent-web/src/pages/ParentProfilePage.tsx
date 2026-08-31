import React, { useState, useEffect } from 'react';
import { useToast } from '../components/Toast';
import { api } from '../api/client';

export const ParentProfilePage: React.FC = () => {
  const { showToast } = useToast();
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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

  useEffect(() => {
    fetchProfile();
  }, []);

  const fetchProfile = async () => {
    setLoading(true);
    try {
      const data = await api.getProfile();
      setProfile(data);
      setName(data.name || '');
      setMobileNumber(data.mobileNumber || '');
      setTimezone(data.timezone || 'UTC');
      setLanguage(data.language || 'en-US');
      if (data.notificationPrefs) setNotificationPrefs(data.notificationPrefs);
    } catch (e) {
      console.error('Error fetching profile:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await api.updateProfile({
        name,
        mobileNumber,
        timezone,
        language,
        notificationPrefs,
      });
      setProfile(updated);
      showToast('Profile updated successfully!', 'success');
    } catch (e: any) {
      showToast(e.message || 'Failed to update profile', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-slate-400">Loading parent profile...</div>;
  }

  return (
    <div className="max-w-3xl space-y-6 animate-fadeIn">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-extrabold text-white tracking-tight">Parent Profile</h1>
        <p className="text-xs text-slate-400">Manage your identity, communication contact, timezone and notifications</p>
      </div>

      <form onSubmit={handleSave} className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6 shadow-xl">
        <div className="flex items-center gap-4 pb-4 border-b border-slate-800">
          <div className="w-16 h-16 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-2xl text-emerald-400 font-bold">
            {profile?.name ? profile.name.charAt(0).toUpperCase() : 'P'}
          </div>
          <div>
            <div className="text-lg font-bold text-white flex items-center gap-2">
              <span>{profile?.name}</span>
              <span className="text-xs px-2 py-0.5 bg-emerald-500/20 text-emerald-300 rounded-full font-bold">
                {profile?.familyRole || 'OWNER'}
              </span>
            </div>
            <p className="text-xs text-slate-400">{profile?.familyName} • Member since {new Date(profile?.createdAt || Date.now()).toLocaleDateString()}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Full Name
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Email Address
            </label>
            <input
              type="email"
              disabled
              value={profile?.email || ''}
              className="w-full bg-slate-950/40 border border-slate-800 rounded-xl px-3.5 py-2.5 text-slate-400 text-sm cursor-not-allowed"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Mobile Number (Optional)
            </label>
            <input
              type="tel"
              value={mobileNumber}
              onChange={(e) => setMobileNumber(e.target.value)}
              placeholder="+1 (555) 000-0000"
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Timezone
            </label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-emerald-500"
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

        {/* Notification Preferences */}
        <div className="pt-4 border-t border-slate-800 space-y-3">
          <h3 className="text-sm font-bold text-white">Notification Preferences</h3>
          <div className="space-y-2">
            {[
              { key: 'requestAlerts', label: 'Instant Ask Parent Alerts', desc: 'Push alert as soon as child submits a request' },
              { key: 'tamperAlerts', label: 'Tamper & Protection Health Warnings', desc: 'Notify if child disconnects VPN or removes agent' },
              { key: 'emailAlerts', label: 'Security & Sign-in Notifications', desc: 'Alert upon new login, password change or MFA change' },
            ].map((pref) => (
              <label key={pref.key} className="flex items-start gap-3 p-3 rounded-xl bg-slate-950/50 border border-slate-800 hover:border-slate-700 cursor-pointer transition">
                <input
                  type="checkbox"
                  checked={(notificationPrefs as any)[pref.key]}
                  onChange={(e) =>
                    setNotificationPrefs({
                      ...notificationPrefs,
                      [pref.key]: e.target.checked,
                    })
                  }
                  className="mt-1 rounded bg-slate-900 border-slate-700 text-emerald-600 focus:ring-emerald-500"
                />
                <div>
                  <div className="text-sm font-semibold text-white">{pref.label}</div>
                  <div className="text-xs text-slate-400">{pref.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={saving}
            className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition shadow-lg shadow-emerald-600/20 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Profile Changes'}
          </button>
        </div>
      </form>
    </div>
  );
};
