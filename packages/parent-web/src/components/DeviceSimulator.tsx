import React, { useState, useEffect } from 'react';
import { Child, Device, Policy, api } from '../api/client';
import {
  Smartphone,
  Laptop,
  ArrowRight,
  ShieldAlert,
  ShieldCheck,
  RotateCw,
  Send,
  HelpCircle,
  Clock,
  Sparkles,
  Lock
} from 'lucide-react';

interface DeviceSimulatorProps {
  child: Child;
  devices: Device[];
  policy: Policy | null;
  onRefreshAll: () => void;
}

export const DeviceSimulator: React.FC<DeviceSimulatorProps> = ({
  child,
  devices,
  policy,
  onRefreshAll,
}) => {
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [urlInput, setUrlInput] = useState<string>('youtube.com');
  const [currentUrl, setCurrentUrl] = useState<string>('youtube.com');
  const [evaluation, setEvaluation] = useState<{ action: 'ALLOW' | 'BLOCK'; reason?: string; expiresAt?: string | null }>({
    action: 'BLOCK',
    reason: 'EXPLICIT_BLOCK',
  });

  const [showAskReason, setShowAskReason] = useState(false);
  const [askReason, setAskReason] = useState('');
  const [requestSent, setRequestSent] = useState(false);
  const [heartbeatActive, setHeartbeatActive] = useState(true);

  // Set default selected device
  useEffect(() => {
    if (devices.length > 0 && (!selectedDeviceId || !devices.find((d) => d.id === selectedDeviceId))) {
      setSelectedDeviceId(devices[0].id);
    }
  }, [devices, selectedDeviceId]);

  // Periodic heartbeat from this simulated device
  useEffect(() => {
    if (!selectedDeviceId || !heartbeatActive) return;
    const currentDevice = devices.find((d) => d.id === selectedDeviceId);
    if (!currentDevice) return;

    const interval = setInterval(async () => {
      try {
        await fetch('/api/devices/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId: currentDevice.id,
            deviceToken: currentDevice.deviceToken,
            activePolicyVersion: policy?.version || 1,
            enforcementActive: true,
            platform: currentDevice.platform,
            agentVersion: '1.0.0',
          }),
        });
      } catch (e) {
        // Heartbeat failure ignored
      }
    }, 15000);

    return () => clearInterval(interval);
  }, [selectedDeviceId, policy, devices, heartbeatActive]);

  // Evaluate current URL against policy whenever URL or policy changes
  useEffect(() => {
    if (!policy) return;

    let target = urlInput.trim().toLowerCase();
    target = target.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];

    const now = new Date();

    if (policy.isPaused) {
      if (policy.pauseExpiresAt && new Date(policy.pauseExpiresAt) > now) {
        setEvaluation({ action: 'BLOCK', reason: 'PAUSED_INTERNET', expiresAt: policy.pauseExpiresAt });
        return;
      } else if (!policy.pauseExpiresAt) {
        setEvaluation({ action: 'BLOCK', reason: 'PAUSED_INTERNET' });
        return;
      }
    }

    // 1. Temporary allow rule
    const tempRule = policy.rules.find((r) => {
      if (r.action !== 'TEMPORARY_ALLOW') return false;
      const isMatch = target === r.domain || target.endsWith('.' + r.domain);
      if (!isMatch || !r.expiresAt) return false;
      return new Date(r.expiresAt) > now;
    });

    if (tempRule) {
      setEvaluation({ action: 'ALLOW', reason: 'TEMPORARY_ALLOW', expiresAt: tempRule.expiresAt });
      return;
    }

    // 2. Explicit Allow
    const explicitAllow = policy.rules.find(
      (r) => r.action === 'ALLOW' && (target === r.domain || target.endsWith('.' + r.domain))
    );
    if (explicitAllow) {
      setEvaluation({ action: 'ALLOW', reason: 'EXPLICIT_ALLOW' });
      return;
    }

    // 3. Explicit Block
    const explicitBlock = policy.rules.find(
      (r) => r.action === 'BLOCK' && (target === r.domain || target.endsWith('.' + r.domain))
    );
    if (explicitBlock) {
      setEvaluation({ action: 'BLOCK', reason: 'EXPLICIT_BLOCK' });
      return;
    }

    // 4. Default Allow
    setEvaluation({ action: 'ALLOW', reason: 'DEFAULT_ALLOW' });
  }, [urlInput, policy]);

  const handleNavigate = (domain: string) => {
    setUrlInput(domain);
    setCurrentUrl(domain);
    setShowAskReason(false);
    setRequestSent(false);

    // Privacy-first activity logging
    if (selectedDeviceId) {
      const currentDevice = devices.find((d) => d.id === selectedDeviceId);
      if (currentDevice) {
        fetch('/api/activity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            childId: child.id,
            deviceId: currentDevice.id,
            domain,
            action: evaluation.action === 'BLOCK' ? 'BLOCKED' : 'ALLOWED',
          }),
        }).catch(() => {});
      }
    }
  };

  const handleSendAskRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDeviceId) return;

    try {
      await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          childId: child.id,
          deviceId: selectedDeviceId,
          domain: currentUrl,
          reason: askReason.trim() || undefined,
        }),
      });

      setRequestSent(true);
      setShowAskReason(false);
      setAskReason('');
      onRefreshAll();
    } catch (e) {
      alert('Failed to send request');
    }
  };

  const selectedDevice = devices.find((d) => d.id === selectedDeviceId);

  return (
    <div className="bg-slate-900 text-white rounded-3xl p-6 sm:p-7 shadow-xl border border-slate-800">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-5 border-b border-slate-800">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h3 className="text-lg font-black tracking-tight text-white">Live Device Simulator</h3>
              <span className="bg-emerald-500/20 text-emerald-300 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full border border-emerald-500/30">
                Interactive POC
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Test real-time cross-device enforcement & "Ask Parent" request flow.
            </p>
          </div>
        </div>

        {/* Device Switcher */}
        <div className="flex items-center space-x-2">
          {devices.map((dev) => (
            <button
              key={dev.id}
              onClick={() => setSelectedDeviceId(dev.id)}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                selectedDeviceId === dev.id
                  ? 'bg-white text-slate-900 shadow-md'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {dev.platform === 'android' ? (
                <Smartphone className="w-3.5 h-3.5 text-emerald-500" />
              ) : (
                <Laptop className="w-3.5 h-3.5 text-blue-400" />
              )}
              <span>{dev.name.split("'s ")[1] || dev.name}</span>
            </button>
          ))}
        </div>
      </div>

      {devices.length === 0 ? (
        <div className="py-12 text-center text-slate-400 text-sm">
          Pair a device above to launch the live simulator.
        </div>
      ) : (
        <div className="mt-5">
          {/* Simulated Browser Frame */}
          <div className="bg-slate-950 rounded-2xl border border-slate-800 overflow-hidden shadow-2xl">
            {/* Browser Address Bar */}
            <div className="bg-slate-900 px-4 py-3 border-b border-slate-800 flex items-center space-x-3">
              <div className="flex space-x-1.5">
                <span className="w-3 h-3 rounded-full bg-red-500/80"></span>
                <span className="w-3 h-3 rounded-full bg-amber-500/80"></span>
                <span className="w-3 h-3 rounded-full bg-emerald-500/80"></span>
              </div>

              <div className="flex-1 flex items-center bg-slate-950 px-3.5 py-1.5 rounded-xl border border-slate-800 text-xs">
                <Lock className="w-3.5 h-3.5 text-emerald-400 mr-2 shrink-0" />
                <input
                  type="text"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleNavigate(urlInput)}
                  className="bg-transparent text-slate-200 focus:outline-none w-full font-mono"
                  placeholder="Type a website domain..."
                />
                <button
                  onClick={() => handleNavigate(urlInput)}
                  className="p-1 hover:text-emerald-400 text-slate-400 transition-all"
                >
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>

              <div className="text-[11px] font-bold text-slate-400 flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                <span>Enforcing Local Policy v{policy?.version || 1}</span>
              </div>
            </div>

            {/* Quick Website Preset Pills */}
            <div className="bg-slate-900/60 px-4 py-2 border-b border-slate-800/80 flex items-center space-x-2 overflow-x-auto text-xs">
              <span className="text-slate-500 text-[11px] font-bold uppercase">Quick Test:</span>
              {['youtube.com', 'instagram.com', 'reddit.com', 'wikipedia.org', 'google.com'].map((dom) => (
                <button
                  key={dom}
                  onClick={() => handleNavigate(dom)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
                    currentUrl === dom
                      ? 'bg-emerald-600 text-white font-bold'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {dom}
                </button>
              ))}
            </div>

            {/* Simulated Web View Content Area */}
            <div className="p-6 sm:p-10 min-h-[320px] flex items-center justify-center">
              {evaluation.action === 'ALLOW' ? (
                /* ALLOWED SCREEN */
                <div className="text-center max-w-md animate-fadeIn">
                  <div className="w-16 h-16 rounded-3xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-emerald-500/10">
                    <ShieldCheck className="w-8 h-8" />
                  </div>
                  <h4 className="text-xl font-black text-white">{currentUrl} is Allowed</h4>
                  <p className="text-xs text-slate-400 mt-1 mb-4">
                    {evaluation.reason === 'TEMPORARY_ALLOW'
                      ? `Temporary Parent Approval Active (Expires: ${new Date(evaluation.expiresAt!).toLocaleTimeString()})`
                      : 'Safe to browse according to Rahul\'s protection policy.'}
                  </p>
                  <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-bold">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                    <span>Content Loaded Successfully</span>
                  </div>
                </div>
              ) : (
                /* BLOCKED SCREEN (CHILD EXPERIENCE SECTION 7.6) */
                <div className="text-center max-w-md animate-fadeIn w-full bg-slate-900/90 p-6 sm:p-8 rounded-3xl border border-red-500/30 shadow-2xl">
                  <div className="w-16 h-16 rounded-3xl bg-red-500/20 text-red-400 border border-red-500/30 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-red-500/10">
                    <ShieldAlert className="w-8 h-8" />
                  </div>
                  <div className="text-xs uppercase font-extrabold tracking-widest text-red-400 mb-1">
                    SafeBrowse Protection
                  </div>
                  <h4 className="text-xl font-black text-white mb-2">
                    {currentUrl} is restricted
                  </h4>
                  <p className="text-xs text-slate-400 mb-6">
                    This website is currently restricted by your family protection settings.
                  </p>

                  {/* Ask Parent Button & Flow */}
                  {requestSent ? (
                    <div className="p-4 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-xs font-bold flex items-center justify-center space-x-2">
                      <Sparkles className="w-4 h-4" />
                      <span>Request sent to your parent! Check dashboard for approval.</span>
                    </div>
                  ) : showAskReason ? (
                    <form onSubmit={handleSendAskRequest} className="space-y-3 text-left">
                      <label className="block text-xs font-bold text-slate-300">
                        Why do you need this website?
                      </label>
                      <input
                        type="text"
                        required
                        placeholder="e.g. Need a maths tutorial for biology class"
                        value={askReason}
                        onChange={(e) => setAskReason(e.target.value)}
                        className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-white text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500 font-medium"
                      />
                      <div className="flex items-center space-x-2 pt-1">
                        <button
                          type="button"
                          onClick={() => setShowAskReason(false)}
                          className="px-3 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          className="flex-1 py-2.5 px-4 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white flex items-center justify-center space-x-1.5 shadow-md shadow-emerald-600/30"
                        >
                          <Send className="w-3.5 h-3.5" />
                          <span>Send Request to Parent</span>
                        </button>
                      </div>
                    </form>
                  ) : (
                    <button
                      onClick={() => setShowAskReason(true)}
                      className="w-full py-3 px-5 rounded-2xl font-black text-sm bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white shadow-lg shadow-emerald-600/25 flex items-center justify-center space-x-2 transition-all transform hover:-translate-y-0.5"
                    >
                      <HelpCircle className="w-4 h-4" />
                      <span>Ask Parent for Access</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
