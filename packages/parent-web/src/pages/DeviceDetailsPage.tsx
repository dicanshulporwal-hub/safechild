import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, DeviceDetails, Child } from '../api/client';
import { useToast } from '../components/Toast';
import {
  Laptop,
  Smartphone,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  RefreshCw,
  Activity,
  ArrowLeft,
  Clock,
  UserCheck,
  Edit2,
  Trash2,
  CheckCircle,
  ExternalLink,
  Lock,
  Globe,
  Radio,
  FileText,
} from 'lucide-react';

interface DeviceDetailsPageProps {
  childrenList: Child[];
}

export const DeviceDetailsPage: React.FC<DeviceDetailsPageProps> = ({ childrenList }) => {
  const { deviceId } = useParams<{ deviceId: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [details, setDetails] = useState<DeviceDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  // Rename modal
  const [showRename, setShowRename] = useState(false);
  const [newName, setNewName] = useState('');
  const [savingRename, setSavingRename] = useState(false);

  // Reassign modal
  const [showReassign, setShowReassign] = useState(false);
  const [newChildId, setNewChildId] = useState('');
  const [savingReassign, setSavingReassign] = useState(false);

  // Unpair modal
  const [showUnpair, setShowUnpair] = useState(false);
  const [unpairing, setUnpairing] = useState(false);

  useEffect(() => {
    if (deviceId) {
      fetchDetails(deviceId);
    }
  }, [deviceId]);

  const fetchDetails = async (id: string, forceRefresh = false) => {
    setLoading(true);
    try {
      const data = await api.getDeviceDetails(id, forceRefresh);
      setDetails(data);
      if (data?.device?.name) {
        setNewName(data.device.name);
      }
      if (data?.device?.childId) {
        setNewChildId(data.device.childId);
      }
    } catch (e: any) {
      console.error('Error fetching device details:', e);
      showToast(e.message || 'Failed to load device details', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSyncPolicy = async () => {
    if (!deviceId) return;
    setSyncing(true);
    try {
      await api.syncDevicePolicy(deviceId);
      showToast('Policy sync signal pushed to agent', 'success');
      await fetchDetails(deviceId, true);
    } catch (e: any) {
      showToast(e.message || 'Failed to trigger policy sync', 'error');
    } finally {
      setSyncing(false);
    }
  };

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deviceId || !newName.trim()) return;
    setSavingRename(true);
    try {
      await api.renameDevice(deviceId, newName.trim());
      showToast('Device renamed successfully', 'success');
      setShowRename(false);
      await fetchDetails(deviceId, true);
    } catch (e: any) {
      showToast(e.message || 'Failed to rename device', 'error');
    } finally {
      setSavingRename(false);
    }
  };

  const handleReassignSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deviceId || !newChildId) return;
    setSavingReassign(true);
    try {
      await api.reassignDevice(deviceId, newChildId);
      showToast('Device reassigned to new child', 'success');
      setShowReassign(false);
      await fetchDetails(deviceId, true);
    } catch (e: any) {
      showToast(e.message || 'Failed to reassign device', 'error');
    } finally {
      setSavingReassign(false);
    }
  };

  const handleUnpairSubmit = async () => {
    if (!deviceId) return;
    setUnpairing(true);
    try {
      await api.removeDevice(deviceId);
      showToast('Device unpaired and token revoked', 'success');
      navigate('/devices');
    } catch (e: any) {
      showToast(e.message || 'Failed to unpair device', 'error');
    } finally {
      setUnpairing(false);
    }
  };

  if (loading) {
    return (
      <div className="py-24 text-center space-y-3 animate-fadeIn">
        <RefreshCw className="w-8 h-8 text-indigo-400 animate-spin mx-auto" />
        <p className="text-xs text-slate-400">Loading device details...</p>
      </div>
    );
  }

  if (!details || !details.device) {
    return (
      <div className="max-w-xl mx-auto py-16 text-center space-y-4 animate-fadeIn">
        <h2 className="text-lg font-bold text-white">Device Not Found</h2>
        <p className="text-xs text-slate-400">
          This device may have been unpaired or removed from your family account.
        </p>
        <Link
          to="/devices"
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-xs font-semibold rounded-xl"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Devices</span>
        </Link>
      </div>
    );
  }

  const { device, child, policy } = details;
  const isOnline = device.isOnline ?? false;
  const hasMultiple =
    device.hasMultipleSessions ||
    device.healthStatus === 'attention_required' ||
    device.healthState === 'DEGRADED';
  const isBypass = device.protectionStatus === 'PARENT_BYPASS' || device.healthStatus === 'BYPASSED';

  const formatLastSeen = (dateStr?: string) => {
    if (!dateStr) return 'Never';
    const elapsed = Math.round((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (elapsed < 60) return `${elapsed}s ago`;
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
    if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
    return new Date(dateStr).toLocaleString();
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto animate-fadeIn">
      {/* Back Link */}
      <button
        onClick={() => navigate('/devices')}
        className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-white transition"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Back to All Devices</span>
      </button>

      {/* Header Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center flex-shrink-0 text-slate-200">
            {device.platform === 'android' ? (
              <Smartphone className="w-7 h-7 text-emerald-400" />
            ) : (
              <Laptop className="w-7 h-7 text-indigo-400" />
            )}
          </div>
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl font-extrabold text-white tracking-tight">{device.name}</h1>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                {device.platform.toUpperCase()}
              </span>

              {/* Status Badge */}
              {hasMultiple ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Attention Required
                </span>
              ) : !isOnline ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-slate-800 text-slate-400 border border-slate-700">
                  <span className="w-2 h-2 rounded-full bg-slate-500" />
                  Offline
                </span>
              ) : isBypass ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/30">
                  <ShieldAlert className="w-3.5 h-3.5" />
                  Parent / Unmanaged
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Protected
                </span>
              )}
            </div>

            <p className="text-xs text-slate-400">
              Paired on {new Date(device.pairedAt || Date.now()).toLocaleDateString()} • Device ID:{' '}
              <span className="font-mono text-slate-300">{device.id}</span>
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={handleSyncPolicy}
            disabled={syncing}
            className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl transition flex items-center gap-2 shadow-lg shadow-indigo-600/20 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            <span>Sync Policy</span>
          </button>

          <button
            onClick={() => navigate(`/devices/${device.id}/diagnostics`)}
            className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-emerald-400 text-xs font-semibold rounded-xl transition flex items-center gap-2 border border-slate-700"
          >
            <Activity className="w-3.5 h-3.5" />
            <span>Diagnostics</span>
          </button>

          <button
            onClick={() => setShowRename(true)}
            className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl transition border border-slate-700"
            title="Rename Device"
          >
            <Edit2 className="w-4 h-4" />
          </button>

          <button
            onClick={() => setShowReassign(true)}
            className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl transition border border-slate-700"
          >
            Reassign Child
          </button>

          <button
            onClick={() => setShowUnpair(true)}
            className="p-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 rounded-xl transition border border-rose-500/30"
            title="Unpair Device"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Multi-Session Safety Guard Banner */}
      {hasMultiple && (
        <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-2xl flex items-start gap-3.5 text-xs text-amber-200">
          <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h4 className="font-bold text-amber-300">
              Multiple Windows Sessions Detected (Attention Required)
            </h4>
            <p className="text-amber-200/90 leading-relaxed">
              SafeBrowse userspace loopback DNS cannot isolate concurrent background network packets
              under Windows Fast User Switching. To prevent filtering conflicts or unexpected policy
              leakage between users, please sign out inactive Windows user accounts.
            </p>
          </div>
        </div>
      )}

      {/* Main Grid: 4 Core Sections */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Card 1: Connection & Telemetry */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Radio className="w-4 h-4 text-indigo-400" />
              Connection & Telemetry
            </h3>
            <span
              className={`w-2 h-2 rounded-full ${
                isOnline ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'
              }`}
            />
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Heartbeat State:</span>
              <span className="font-semibold text-white">
                {isOnline ? 'Online (Within 90s)' : 'Offline / Unreachable'}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-slate-400">Last Ping:</span>
              <span className="font-mono text-slate-200">{formatLastSeen(device.lastHeartbeatAt)}</span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-slate-400">Last Policy Sync:</span>
              <span className="font-mono text-slate-200">{formatLastSeen(device.lastSyncAt)}</span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-slate-400">SafeBrowse Agent:</span>
              <span className="font-mono text-indigo-300">
                {device.agentVersion || '1.0.0-pilot'}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-slate-400">Active Policy Version:</span>
              <span className="font-mono text-emerald-400">v{device.activePolicyVersion || 1}</span>
            </div>
          </div>
        </div>

        {/* Card 2: Windows Account & Shared Laptop Isolation */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-indigo-400" />
              Windows Account Mapping
            </h3>
            <span className="text-[10px] font-semibold text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
              Single-Active-User
            </span>
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Assigned Child:</span>
              <span className="font-bold text-indigo-300">{child?.name || 'Unassigned'}</span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-slate-400">Child Policy:</span>
              <span className="font-mono text-emerald-400">v{device.activePolicyVersion || policy?.version || 1} configured</span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-slate-400">Current Session:</span>
              <span className="font-bold text-white">
                {device.windowsAccountName
                  ? `${device.windowsAccountName} (${isBypass ? 'Parent / Unmanaged' : 'Child / Managed'})`
                  : (isBypass ? 'Parent / Unmanaged' : 'Child / Managed')}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-slate-400">Protection:</span>
              <span
                className={`font-semibold ${
                  isBypass ? 'text-blue-400' : hasMultiple ? 'text-amber-400' : 'text-emerald-400'
                }`}
              >
                {isBypass
                  ? 'Not currently enforcing child policy'
                  : hasMultiple
                  ? 'Attention Required (Multiple sessions)'
                  : 'Protected'}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-slate-400">Session Status:</span>
              <span
                className={`font-semibold ${
                  hasMultiple ? 'text-amber-400' : 'text-emerald-400'
                }`}
              >
                {hasMultiple ? 'Multiple Sessions Detected' : 'Isolated Active Session'}
              </span>
            </div>

            <div className="pt-1">
              <p className="text-[11px] text-slate-500 leading-normal">
                To switch profiles or designate unmanaged parent accounts, open the SafeBrowse setup
                utility on the device at{' '}
                <span className="text-slate-400 font-mono">http://127.0.0.1:8885</span>.
              </p>
            </div>
          </div>
        </div>

        {/* Card 3: Active Protection Policies */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Globe className="w-4 h-4 text-emerald-400" />
              Active Child Policies
            </h3>
            {child && (
              <Link
                to={`/children/${child.id}`}
                className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
              >
                <span>Edit Policy</span>
                <ExternalLink className="w-3 h-3" />
              </Link>
            )}
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Web Protection:</span>
              <span className="font-bold text-emerald-400 flex items-center gap-1">
                <CheckCircle className="w-3.5 h-3.5" />
                Active (Synthetic NXDOMAIN)
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-slate-400">SafeSearch:</span>
              <span className="font-semibold text-white">
                {policy?.safeSearch?.enabled ? 'Strict Enforcement' : 'Disabled'}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-slate-400">Restricted YouTube:</span>
              <span className="font-semibold text-white">
                {policy?.safeSearch?.youtubeRestricted ? 'Strict Mode' : 'Standard'}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-slate-400">Study Mode:</span>
              <span className="font-semibold text-white">
                {policy?.studyMode ? 'Active (Restricted Browsing)' : 'Normal'}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-slate-400">Custom Allowed/Blocked Rules:</span>
              <span className="font-mono text-slate-200">
                {policy?.customRulesCount ?? 0} rules
              </span>
            </div>
          </div>
        </div>

        {/* Card 4: Integrity & Health Diagnostics */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-400" />
              Health & Integrity Checks
            </h3>
            <button
              onClick={() => navigate(`/devices/${device.id}/diagnostics`)}
              className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1 font-semibold"
            >
              <span>Full Diagnostics</span>
              <ExternalLink className="w-3 h-3" />
            </button>
          </div>

          <div className="space-y-2.5 text-xs">
            <div className="flex items-center justify-between p-2 rounded-xl bg-slate-950 border border-slate-800">
              <span className="text-slate-300">Agent Service Host</span>
              <span className="text-emerald-400 font-semibold flex items-center gap-1">
                <CheckCircle className="w-3.5 h-3.5" /> Healthy
              </span>
            </div>

            <div className="flex items-center justify-between p-2 rounded-xl bg-slate-950 border border-slate-800">
              <span className="text-slate-300">Loopback DNS Proxy (127.0.0.1:53)</span>
              <span className="text-emerald-400 font-semibold flex items-center gap-1">
                <CheckCircle className="w-3.5 h-3.5" /> Listening
              </span>
            </div>

            <div className="flex items-center justify-between p-2 rounded-xl bg-slate-950 border border-slate-800">
              <span className="text-slate-300">Fast User Switching Attribution</span>
              <span
                className={`font-semibold flex items-center gap-1 ${
                  hasMultiple ? 'text-amber-400' : 'text-emerald-400'
                }`}
              >
                {hasMultiple ? 'Degraded (Multiple Sessions)' : 'Single Session Clean'}
              </span>
            </div>

            <div className="flex items-center justify-between p-2 rounded-xl bg-slate-950 border border-slate-800">
              <span className="text-slate-300">Cloud WebSocket Push</span>
              <span className="text-emerald-400 font-semibold flex items-center gap-1">
                <CheckCircle className="w-3.5 h-3.5" /> Synchronized
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* --- Rename Modal --- */}
      {showRename && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fadeIn">
          <form
            onSubmit={handleRenameSubmit}
            className="bg-slate-900 border border-slate-800 rounded-3xl max-w-md w-full p-6 space-y-4 shadow-2xl"
          >
            <h3 className="text-base font-bold text-white">Rename Device</h3>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Rahul Acer Laptop"
              maxLength={40}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-indigo-500"
              required
            />
            <div className="flex justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setShowRename(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-xl transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingRename || !newName.trim()}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl transition disabled:opacity-50"
              >
                {savingRename ? 'Saving...' : 'Save Name'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* --- Reassign Child Modal --- */}
      {showReassign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fadeIn">
          <form
            onSubmit={handleReassignSubmit}
            className="bg-slate-900 border border-slate-800 rounded-3xl max-w-md w-full p-6 space-y-4 shadow-2xl"
          >
            <h3 className="text-base font-bold text-white">Reassign Device Profile</h3>
            <select
              value={newChildId}
              onChange={(e) => setNewChildId(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-indigo-500"
            >
              {childrenList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} {c.age ? `(${c.age} yrs)` : ''}
                </option>
              ))}
            </select>
            <div className="flex justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setShowReassign(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-xl transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingReassign || !newChildId}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl transition disabled:opacity-50"
              >
                {savingReassign ? 'Reassigning...' : 'Reassign Device'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* --- Unpair Confirm Modal --- */}
      {showUnpair && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fadeIn">
          <div className="bg-slate-900 border border-rose-500/40 rounded-3xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <h3 className="text-base font-bold text-rose-400 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-rose-400" />
              Unpair {device.name}?
            </h3>
            <p className="text-xs text-slate-300 leading-relaxed">
              Unpairing immediately revokes authentication tokens for this device. Protection
              will be detached until the device is re-paired.
            </p>
            <div className="flex justify-end gap-2.5 pt-2">
              <button
                onClick={() => setShowUnpair(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-xl transition"
              >
                Cancel
              </button>
              <button
                onClick={handleUnpairSubmit}
                disabled={unpairing}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl transition disabled:opacity-50"
              >
                {unpairing ? 'Unpairing...' : 'Confirm Unpair'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
