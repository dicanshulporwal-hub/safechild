import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api, Device, Child } from '../api/client';
import { useToast } from '../components/Toast';
import {
  Laptop,
  Smartphone,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  RefreshCw,
  Activity,
  Edit2,
  Trash2,
  ExternalLink,
  Plus,
  Clock,
  UserCheck,
  CheckCircle,
  Copy,
  Info,
} from 'lucide-react';

interface DevicesPageProps {
  childrenList: Child[];
}

export const DevicesPage: React.FC<DevicesPageProps> = ({ childrenList }) => {
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  // Pairing Modal
  const [showPairModal, setShowPairModal] = useState(false);
  const [selectedChildForPair, setSelectedChildForPair] = useState<string>(
    childrenList[0]?.id || ''
  );
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingExpiry, setPairingExpiry] = useState<string | null>(null);
  const [generatingCode, setGeneratingCode] = useState(false);

  // Rename Modal
  const [renameDeviceTarget, setRenameDeviceTarget] = useState<Device | null>(null);
  const [newDeviceName, setNewDeviceName] = useState('');
  const [savingRename, setSavingRename] = useState(false);

  // Reassign Modal
  const [reassignTarget, setReassignTarget] = useState<Device | null>(null);
  const [newChildId, setNewChildId] = useState('');
  const [savingReassign, setSavingReassign] = useState(false);

  // Unpair Confirm Modal
  const [unpairTarget, setUnpairTarget] = useState<Device | null>(null);
  const [unpairing, setUnpairing] = useState(false);

  useEffect(() => {
    fetchDevices();
  }, []);

  const fetchDevices = async (forceRefresh = false) => {
    setLoading(true);
    try {
      const data = await api.getAllDevices(forceRefresh);
      setDevices(Array.isArray(data) ? data : []);
    } catch (e: any) {
      console.error('Error fetching devices:', e);
      showToast(e.message || 'Failed to load devices', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSyncPolicy = async (device: Device) => {
    setSyncingId(device.id);
    try {
      await api.syncDevicePolicy(device.id);
      showToast(`Policy sync signal sent to ${device.name}`, 'success');
      await fetchDevices(true);
    } catch (e: any) {
      showToast(e.message || 'Failed to trigger policy sync', 'error');
    } finally {
      setSyncingId(null);
    }
  };

  const handleGeneratePairingCode = async () => {
    if (!selectedChildForPair) {
      showToast('Please select a child profile first', 'error');
      return;
    }
    setGeneratingCode(true);
    try {
      const res = await api.createPairingCode(selectedChildForPair);
      setPairingCode(res.code);
      setPairingExpiry(res.expiresAt);
      showToast('6-digit pairing code generated!', 'success');
    } catch (e: any) {
      showToast(e.message || 'Failed to generate pairing code', 'error');
    } finally {
      setGeneratingCode(false);
    }
  };

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameDeviceTarget || !newDeviceName.trim()) return;
    setSavingRename(true);
    try {
      await api.renameDevice(renameDeviceTarget.id, newDeviceName.trim());
      showToast('Device renamed successfully', 'success');
      setRenameDeviceTarget(null);
      await fetchDevices(true);
    } catch (e: any) {
      showToast(e.message || 'Failed to rename device', 'error');
    } finally {
      setSavingRename(false);
    }
  };

  const handleReassignSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reassignTarget || !newChildId) return;
    setSavingReassign(true);
    try {
      await api.reassignDevice(reassignTarget.id, newChildId);
      showToast('Device reassigned to new child profile', 'success');
      setReassignTarget(null);
      await fetchDevices(true);
    } catch (e: any) {
      showToast(e.message || 'Failed to reassign device', 'error');
    } finally {
      setSavingReassign(false);
    }
  };

  const handleUnpairSubmit = async () => {
    if (!unpairTarget) return;
    setUnpairing(true);
    try {
      await api.removeDevice(unpairTarget.id);
      showToast(`${unpairTarget.name} has been unpaired and its token revoked`, 'success');
      setUnpairTarget(null);
      await fetchDevices(true);
    } catch (e: any) {
      showToast(e.message || 'Failed to unpair device', 'error');
    } finally {
      setUnpairing(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    showToast('Copied to clipboard', 'info');
  };

  // Helper for status badge
  const renderStatusBadge = (device: Device) => {
    const isOnline = device.isOnline ?? false;
    const isMultiple = device.hasMultipleSessions || device.healthStatus === 'attention_required' || device.healthState === 'DEGRADED';
    const isBypass = device.protectionStatus === 'PARENT_BYPASS' || device.healthStatus === 'BYPASSED';

    if (isMultiple) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30">
          <AlertTriangle className="w-3.5 h-3.5" />
          Attention Required
        </span>
      );
    }

    if (!isOnline) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-800 text-slate-400 border border-slate-700">
          <span className="w-2 h-2 rounded-full bg-slate-500" />
          Offline
        </span>
      );
    }

    if (isBypass) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/30">
          <ShieldAlert className="w-3.5 h-3.5" />
          Parent / Unmanaged
        </span>
      );
    }

    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
        <ShieldCheck className="w-3.5 h-3.5" />
        Protected
      </span>
    );
  };

  const formatLastSeen = (dateStr?: string) => {
    if (!dateStr) return 'Never';
    const elapsed = Math.round((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (elapsed < 60) return `${elapsed}s ago`;
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
    if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
    return new Date(dateStr).toLocaleDateString();
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto animate-fadeIn">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-white tracking-tight flex items-center gap-2.5">
            <Laptop className="w-7 h-7 text-indigo-400" />
            Device Management
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Monitor, synchronize, and configure protection across all family laptops and devices.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => fetchDevices(true)}
            disabled={loading}
            className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-xl transition flex items-center gap-2 border border-slate-700 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>

          <button
            onClick={() => {
              setPairingCode(null);
              setShowPairModal(true);
            }}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl transition flex items-center gap-2 shadow-lg shadow-indigo-600/20"
          >
            <Plus className="w-4 h-4" />
            <span>Pair New Device</span>
          </button>
        </div>
      </div>

      {/* Overview Stat Badges */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
          <p className="text-xs text-slate-400 font-medium">Total Devices</p>
          <p className="text-2xl font-bold text-white mt-1">{devices.length}</p>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
          <p className="text-xs text-emerald-400 font-medium">Online</p>
          <p className="text-2xl font-bold text-emerald-400 mt-1">
            {devices.filter((d) => d.isOnline).length}
          </p>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
          <p className="text-xs text-amber-400 font-medium">Attention Required</p>
          <p className="text-2xl font-bold text-amber-400 mt-1">
            {
              devices.filter(
                (d) =>
                  d.hasMultipleSessions ||
                  d.healthStatus === 'attention_required' ||
                  d.healthState === 'DEGRADED'
              ).length
            }
          </p>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
          <p className="text-xs text-indigo-400 font-medium">Enforced Policies</p>
          <p className="text-2xl font-bold text-indigo-400 mt-1">
            {devices.filter((d) => d.healthStatus !== 'inactive' && !d.isRevoked).length}
          </p>
        </div>
      </div>

      {/* Device List */}
      {loading ? (
        <div className="py-20 text-center space-y-3">
          <RefreshCw className="w-8 h-8 text-indigo-400 animate-spin mx-auto" />
          <p className="text-xs text-slate-400">Loading devices...</p>
        </div>
      ) : devices.length === 0 ? (
        <div className="bg-slate-900/40 border border-dashed border-slate-800 rounded-2xl p-12 text-center space-y-4">
          <div className="w-14 h-14 bg-indigo-500/10 rounded-2xl flex items-center justify-center mx-auto text-indigo-400">
            <Laptop className="w-7 h-7" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">No Devices Paired Yet</h3>
            <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
              Install the SafeBrowse agent on your Windows laptop or tablet and enter a pairing code to get started.
            </p>
          </div>
          <button
            onClick={() => setShowPairModal(true)}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl transition inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            <span>Generate Pairing Code</span>
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {devices.map((device) => {
            const isOnline = device.isOnline ?? false;
            const hasMultiple =
              device.hasMultipleSessions ||
              device.healthStatus === 'attention_required' ||
              device.healthState === 'DEGRADED';

            return (
              <div
                key={device.id}
                className={`bg-slate-900 border rounded-2xl p-5 shadow-lg transition hover:border-slate-700 ${
                  hasMultiple
                    ? 'border-amber-500/40 bg-amber-950/10'
                    : 'border-slate-800'
                }`}
              >
                {/* Attention Banner if multiple sessions */}
                {hasMultiple && (
                  <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-start gap-2.5 text-xs text-amber-300">
                    <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <span className="font-bold">Attention Required:</span> Multiple Windows
                      user sessions detected on this machine. To prevent policy leakage between
                      accounts under Fast User Switching, please sign out background accounts.
                    </div>
                  </div>
                )}

                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
                  {/* Left Column: Device Identity & Metadata */}
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center flex-shrink-0 text-slate-300">
                      {device.platform === 'android' ? (
                        <Smartphone className="w-6 h-6 text-emerald-400" />
                      ) : (
                        <Laptop className="w-6 h-6 text-indigo-400" />
                      )}
                    </div>

                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <Link
                          to={`/devices/${device.id}`}
                          className="text-base font-bold text-white hover:text-indigo-400 transition flex items-center gap-1.5"
                        >
                          {device.name}
                          <ExternalLink className="w-3.5 h-3.5 opacity-50" />
                        </Link>
                        {renderStatusBadge(device)}
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
                          {device.platform.toUpperCase()}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-y-1 gap-x-4 text-xs text-slate-400">
                        <div className="flex items-center gap-1.5">
                          <UserCheck className="w-3.5 h-3.5 text-slate-500" />
                          <span>Child:</span>
                          <span className="font-semibold text-slate-200">
                            {device.childName || 'Unassigned'}
                          </span>
                        </div>

                        {device.windowsAccountName && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-slate-500">Windows Account:</span>
                            <span className="font-semibold text-slate-200">
                              {device.windowsAccountName}
                            </span>
                          </div>
                        )}

                        <div className="flex items-center gap-1.5">
                          <Clock className="w-3.5 h-3.5 text-slate-500" />
                          <span>Last Seen:</span>
                          <span className="text-slate-300">
                            {formatLastSeen(device.lastHeartbeatAt)}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <span className="text-slate-500">Agent:</span>
                          <span className="font-mono text-slate-300">
                            {device.agentVersion || 'v1.0.0-pilot'}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <span className="text-slate-500">Policy:</span>
                          <span className="font-mono text-slate-300">
                            v{device.activePolicyVersion || 1}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Right Column: Actions */}
                  <div className="flex flex-wrap items-center gap-2 pt-2 lg:pt-0 border-t lg:border-t-0 border-slate-800">
                    <button
                      onClick={() => handleSyncPolicy(device)}
                      disabled={syncingId === device.id}
                      title="Send immediate policy synchronization push"
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-xl transition flex items-center gap-1.5 border border-slate-700 disabled:opacity-50"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${
                          syncingId === device.id ? 'animate-spin text-indigo-400' : ''
                        }`}
                      />
                      <span>Sync Policy</span>
                    </button>

                    <button
                      onClick={() => navigate(`/devices/${device.id}/diagnostics`)}
                      title="Run 7-point integrity diagnostics"
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-xl transition flex items-center gap-1.5 border border-slate-700"
                    >
                      <Activity className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Diagnostics</span>
                    </button>

                    <button
                      onClick={() => {
                        setRenameDeviceTarget(device);
                        setNewDeviceName(device.name);
                      }}
                      title="Rename device"
                      className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl transition border border-slate-700"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>

                    <button
                      onClick={() => {
                        setReassignTarget(device);
                        setNewChildId(device.childId);
                      }}
                      title="Reassign to different child profile"
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-indigo-300 text-xs font-medium rounded-xl transition border border-slate-700"
                    >
                      Reassign
                    </button>

                    <button
                      onClick={() => setUnpairTarget(device)}
                      title="Unpair device and revoke credentials"
                      className="p-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 rounded-xl transition border border-rose-500/30"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* --- Pair Device Modal --- */}
      {showPairModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fadeIn">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-md w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <Laptop className="w-5 h-5 text-indigo-400" />
                Pair New Windows Device
              </h3>
              <button
                onClick={() => setShowPairModal(false)}
                className="text-slate-400 hover:text-white text-sm"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              Select which child will initially be protected on this device. You can map
              specific Windows accounts after launching the SafeBrowse installer.
            </p>

            <div className="space-y-3">
              <label className="text-xs font-semibold text-slate-300 block">
                Assign To Child Profile:
              </label>
              <select
                value={selectedChildForPair}
                onChange={(e) => setSelectedChildForPair(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-indigo-500"
              >
                {childrenList.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} {c.age ? `(${c.age} yrs)` : ''}
                  </option>
                ))}
              </select>
            </div>

            {pairingCode ? (
              <div className="bg-slate-950 border border-indigo-500/40 rounded-2xl p-5 text-center space-y-3">
                <p className="text-[11px] font-semibold text-indigo-400 uppercase tracking-wider">
                  Your 6-Digit Pairing Code
                </p>
                <div className="text-3xl font-mono font-black text-white tracking-widest flex items-center justify-center gap-3">
                  <span>{pairingCode}</span>
                  <button
                    onClick={() => copyToClipboard(pairingCode)}
                    className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition"
                    title="Copy code"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-[11px] text-slate-400">
                  Enter this code in the SafeBrowse Windows Setup window (or at{' '}
                  <span className="font-mono text-slate-300">http://127.0.0.1:8885</span>).
                  Valid for 15 minutes.
                </p>
              </div>
            ) : (
              <button
                onClick={handleGeneratePairingCode}
                disabled={generatingCode || !selectedChildForPair}
                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl transition flex items-center justify-center gap-2 shadow-lg disabled:opacity-50"
              >
                {generatingCode ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
                <span>Generate Pairing Code</span>
              </button>
            )}

            <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl flex items-start gap-2.5 text-[11px] text-slate-400">
              <Info className="w-4 h-4 text-slate-500 flex-shrink-0 mt-0.5" />
              <div>
                Windows SafeBrowse operates as a local Windows service. Once paired, parents can
                switch users freely without reinstalling.
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setShowPairModal(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-xl transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- Rename Modal --- */}
      {renameDeviceTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fadeIn">
          <form
            onSubmit={handleRenameSubmit}
            className="bg-slate-900 border border-slate-800 rounded-3xl max-w-md w-full p-6 space-y-4 shadow-2xl"
          >
            <h3 className="text-base font-bold text-white">Rename Device</h3>
            <p className="text-xs text-slate-400">
              Update the friendly display name for{' '}
              <span className="text-white font-medium">{renameDeviceTarget.name}</span>.
            </p>

            <input
              type="text"
              value={newDeviceName}
              onChange={(e) => setNewDeviceName(e.target.value)}
              placeholder="e.g. Acer Family Laptop"
              maxLength={40}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-indigo-500"
              required
            />

            <div className="flex justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setRenameDeviceTarget(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-xl transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingRename || !newDeviceName.trim()}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl transition disabled:opacity-50"
              >
                {savingRename ? 'Saving...' : 'Save Name'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* --- Reassign Child Modal --- */}
      {reassignTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fadeIn">
          <form
            onSubmit={handleReassignSubmit}
            className="bg-slate-900 border border-slate-800 rounded-3xl max-w-md w-full p-6 space-y-4 shadow-2xl"
          >
            <h3 className="text-base font-bold text-white">Reassign Child Profile</h3>
            <p className="text-xs text-slate-400">
              Select which child profile policy should be applied to{' '}
              <span className="text-white font-medium">{reassignTarget.name}</span>.
            </p>

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
                onClick={() => setReassignTarget(null)}
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
      {unpairTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fadeIn">
          <div className="bg-slate-900 border border-rose-500/40 rounded-3xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <h3 className="text-base font-bold text-rose-400 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-rose-400" />
              Unpair {unpairTarget.name}?
            </h3>
            <p className="text-xs text-slate-300 leading-relaxed">
              Are you sure you want to unpair this device? This will revoke its credentials
              immediately. The device will stop receiving policy updates and internet protection
              will be detached until re-paired.
            </p>

            <div className="flex justify-end gap-2.5 pt-2">
              <button
                onClick={() => setUnpairTarget(null)}
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
