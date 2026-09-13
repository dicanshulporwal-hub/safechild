import React, { useState, useEffect } from 'react';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import {
  Users,
  ShieldCheck,
  ShieldAlert,
  Search,
  Key,
  CheckCircle,
  XCircle,
  Activity,
  RotateCcw,
  RefreshCw,
  Eye,
  UserCheck,
  Lock,
  Smartphone,
  Laptop,
  ShieldOff,
} from 'lucide-react';

export const AdminParentsPage: React.FC = () => {
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState<'parents' | 'fleet' | 'audit'>('parents');
  const [parents, setParents] = useState<any[]>([]);
  const [metrics, setMetrics] = useState<any>(null);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Password Reset Modal State
  const [selectedParentForReset, setSelectedParentForReset] = useState<any>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resettingPassword, setResettingPassword] = useState(false);

  // Parent Details Modal State
  const [inspectedParent, setInspectedParent] = useState<any>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // Rollback state
  const [targetVersion, setTargetVersion] = useState('1.1.0');
  const [rollingBack, setRollingBack] = useState(false);

  useEffect(() => {
    fetchAdminData();
  }, []);

  const fetchAdminData = async () => {
    setLoading(true);
    setForbidden(false);
    try {
      const [parentsRes, metricsRes, auditRes] = await Promise.all([
        api.getAdminParents().catch((e) => {
          if (e.message?.includes('Forbidden')) throw e;
          return { parents: [] };
        }),
        api.getAdminMetrics().catch(() => null),
        api.getAdminAudit().catch(() => ({ logs: [] })),
      ]);

      if (parentsRes?.parents) setParents(parentsRes.parents);
      if (metricsRes) setMetrics(metricsRes);
      if (auditRes?.logs) setAuditLogs(auditRes.logs);
    } catch (e: any) {
      if (e.message?.includes('Forbidden')) {
        setForbidden(true);
      }
      console.error('Failed to load admin data:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyEmail = async (parent: any) => {
    try {
      await api.adminVerifyParentEmail(parent.id);
      showToast(`Email verified for ${parent.email}`, 'success');
      fetchAdminData();
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPassword || newPassword.length < 8) {
      showToast('Password must be at least 8 characters', 'error');
      return;
    }
    setResettingPassword(true);
    try {
      await api.adminResetParentPassword(selectedParentForReset.id, newPassword);
      showToast(`Password successfully reset for ${selectedParentForReset.email}`, 'success');
      setSelectedParentForReset(null);
      setNewPassword('');
    } catch (e: any) {
      showToast(e.message, 'error');
    } finally {
      setResettingPassword(false);
    }
  };

  const handleToggleRole = async (parent: any) => {
    const newRole = parent.systemRole === 'SYSTEM_ADMIN' ? 'USER' : 'SYSTEM_ADMIN';
    const confirm = window.confirm(`Are you sure you want to change ${parent.email} role to ${newRole}?`);
    if (!confirm) return;

    try {
      await api.adminChangeUserRole(parent.id, newRole);
      showToast(`Role updated to ${newRole} for ${parent.email}`, 'success');
      fetchAdminData();
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleDisableMfa = async (parent: any) => {
    const confirm = window.confirm(
      `⚠️ EMERGENCY: Are you sure you want to disable Multi-Factor Authentication for ${parent.email}? All active sessions for this user will be revoked.`
    );
    if (!confirm) return;

    try {
      await api.adminDisableParentMfa(parent.id);
      showToast(`MFA disabled for ${parent.email}`, 'success');
      fetchAdminData();
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleInspectParent = async (parentId: string) => {
    setLoadingDetails(true);
    try {
      const details = await api.getAdminParentDetails(parentId);
      setInspectedParent(details);
    } catch (e: any) {
      showToast(e.message, 'error');
    } finally {
      setLoadingDetails(false);
    }
  };

  const handleRollback = async () => {
    setRollingBack(true);
    try {
      const data = await api.dispatchAdminRollback(
        targetVersion,
        'Emergency fleet rollback from System Admin Console'
      );
      showToast(`Rollback dispatched to ${data.result?.affectedDevices || 'all'} devices!`, 'success');
      fetchAdminData();
    } catch (e: any) {
      showToast(e.message || 'Rollback failed', 'error');
    } finally {
      setRollingBack(false);
    }
  };

  if (loading) {
    return <div className="p-12 text-center text-slate-400">Loading System Administrator Console...</div>;
  }

  if (forbidden) {
    return (
      <div className="max-w-2xl mx-auto my-12 p-8 bg-slate-900 border border-rose-900/50 rounded-2xl text-center space-y-4 shadow-2xl animate-fadeIn">
        <div className="w-12 h-12 rounded-2xl bg-rose-500/20 text-rose-400 flex items-center justify-center mx-auto">
          <ShieldAlert className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-bold text-white">403 — Forbidden: System Administrator Access Required</h2>
        <p className="text-xs text-slate-400 max-w-md mx-auto leading-relaxed">
          You are currently logged in as a standard parent. Only accounts with the explicit <span className="font-mono text-emerald-400">SYSTEM_ADMIN</span> role may access global parent management, fleet telemetry, and operations.
        </p>
      </div>
    );
  }

  const filteredParents = parents.filter(
    (p) =>
      p.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-fadeIn pb-12">
      {/* Header Banner */}
      <div className="bg-gradient-to-r from-purple-950/40 via-slate-900 to-slate-900 border border-purple-500/30 rounded-2xl p-6 shadow-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-extrabold text-white tracking-tight">System Administrator Console</h1>
            <span className="text-[10px] font-extrabold bg-purple-500 text-slate-950 px-2.5 py-0.5 rounded-full uppercase tracking-wider">
              Super Admin
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Platform-wide management: Manage parent accounts, monitor device fleet health, and review append-only system audits.
          </p>
        </div>

        <button
          onClick={fetchAdminData}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl transition flex items-center gap-1.5 shadow"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh All</span>
        </button>
      </div>

      {/* Metrics Row */}
      {metrics && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
            <span className="text-[10px] uppercase font-bold text-slate-500">Registered Parents</span>
            <div className="text-2xl font-extrabold text-white mt-1">{metrics.usersCount || parents.length}</div>
          </div>
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
            <span className="text-[10px] uppercase font-bold text-slate-500">Total Families</span>
            <div className="text-2xl font-extrabold text-purple-400 mt-1">{metrics.familiesCount || 0}</div>
          </div>
          <div className="bg-slate-900 border border-emerald-500/30 p-4 rounded-2xl">
            <span className="text-[10px] uppercase font-bold text-emerald-400">Protected Devices</span>
            <div className="text-2xl font-extrabold text-emerald-400 mt-1">{metrics.healthBreakdown?.protected || 0}</div>
          </div>
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
            <span className="text-[10px] uppercase font-bold text-slate-500">Fleet Health</span>
            <div className="text-2xl font-extrabold text-indigo-400 mt-1">{metrics.policySyncSuccessRate || '100%'}</div>
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
        <button
          onClick={() => setActiveTab('parents')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'parents'
              ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/20'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
        >
          <Users className="w-4 h-4" />
          <span>Parent Management ({parents.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('fleet')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'fleet'
              ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/20'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
        >
          <Activity className="w-4 h-4" />
          <span>Fleet Health & Emergency Rollback</span>
        </button>

        <button
          onClick={() => setActiveTab('audit')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'audit'
              ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/20'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
        >
          <ShieldCheck className="w-4 h-4" />
          <span>System Audit Logs ({auditLogs.length})</span>
        </button>
      </div>

      {/* TAB 1: Parent Management */}
      {activeTab === 'parents' && (
        <div className="space-y-4">
          {/* Search Bar */}
          <div className="relative">
            <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search parents by email, name, or User ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 transition"
            />
          </div>

          {/* Parents Table */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950/80 text-slate-400 text-[10px] uppercase tracking-wider border-b border-slate-800 font-bold">
                  <tr>
                    <th className="py-3.5 px-4">Parent / User</th>
                    <th className="py-3.5 px-4">System Role</th>
                    <th className="py-3.5 px-4">Email Status</th>
                    <th className="py-3.5 px-4">MFA</th>
                    <th className="py-3.5 px-4">Families & Children</th>
                    <th className="py-3.5 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredParents.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-500">
                        No parents found matching "{searchQuery}".
                      </td>
                    </tr>
                  ) : (
                    filteredParents.map((parent) => (
                      <tr key={parent.id} className="hover:bg-slate-800/40 transition">
                        <td className="py-3.5 px-4">
                          <div className="font-bold text-white">{parent.name}</div>
                          <div className="text-slate-400 font-mono text-[11px]">{parent.email}</div>
                          <div className="text-[10px] text-slate-500 font-mono mt-0.5">ID: {parent.id}</div>
                        </td>

                        <td className="py-3.5 px-4">
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${
                              parent.systemRole === 'SYSTEM_ADMIN'
                                ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                                : 'bg-slate-800 text-slate-300 border border-slate-700'
                            }`}
                          >
                            {parent.systemRole}
                          </span>
                        </td>

                        <td className="py-3.5 px-4">
                          {parent.emailVerified ? (
                            <span className="inline-flex items-center gap-1 text-emerald-400 font-semibold text-[11px]">
                              <CheckCircle className="w-3.5 h-3.5" /> Verified
                            </span>
                          ) : (
                            <div className="flex items-center gap-2">
                              <span className="inline-flex items-center gap-1 text-amber-400 font-semibold text-[11px]">
                                <XCircle className="w-3.5 h-3.5" /> Pending
                              </span>
                              <button
                                onClick={() => handleVerifyEmail(parent)}
                                className="text-[10px] bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500/30 transition font-bold"
                              >
                                Verify Now
                              </button>
                            </div>
                          )}
                        </td>

                        <td className="py-3.5 px-4">
                          {parent.mfaEnabled ? (
                            <span className="text-emerald-400 font-mono text-[11px]">Enabled</span>
                          ) : (
                            <span className="text-slate-500 font-mono text-[11px]">Disabled</span>
                          )}
                        </td>

                        <td className="py-3.5 px-4">
                          {parent.families?.length === 0 ? (
                            <span className="text-slate-500">None</span>
                          ) : (
                            parent.families.map((f: any) => (
                              <div key={f.familyId} className="text-[11px]">
                                <span className="font-semibold text-slate-300">{f.familyName}</span>
                                <span className="text-slate-500 ml-1">({f.role})</span>
                                <div className="text-[10px] text-slate-400">
                                  {f.children?.length || 0} Children • {f.children?.reduce((acc: number, c: any) => acc + (c.deviceCount || 0), 0) || 0} Devices
                                </div>
                              </div>
                            ))
                          )}
                        </td>

                        <td className="py-3.5 px-4 text-right space-x-2">
                          <button
                            onClick={() => handleInspectParent(parent.id)}
                            title="Inspect full details"
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>

                          <button
                            onClick={() => {
                              setSelectedParentForReset(parent);
                              setNewPassword('');
                            }}
                            title="Reset Password"
                            className="p-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 transition"
                          >
                            <Key className="w-3.5 h-3.5" />
                          </button>

                          <button
                            onClick={() => handleToggleRole(parent)}
                            title="Promote / Demote Role"
                            className="p-1.5 rounded-lg bg-purple-500/10 hover:bg-purple-500/20 text-purple-400 border border-purple-500/30 transition cursor-pointer"
                          >
                            <UserCheck className="w-3.5 h-3.5" />
                          </button>

                          {parent.mfaEnabled && (
                            <button
                              onClick={() => handleDisableMfa(parent)}
                              title="Emergency Disable MFA"
                              className="p-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 transition cursor-pointer"
                            >
                              <ShieldOff className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: Fleet Health & Emergency Rollback */}
      {activeTab === 'fleet' && (
        <div className="space-y-6">
          {/* Rollback Card */}
          <div className="bg-slate-900 border border-rose-900/40 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="pb-3 border-b border-slate-800">
              <h2 className="text-sm font-bold text-rose-400 uppercase tracking-wider flex items-center gap-2">
                <RotateCcw className="w-4 h-4" />
                <span>Emergency Fleet Version Rollback (Kill-Switch)</span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Dispatches an immediate downgrade instruction across all active Windows and Android agents. Audited.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
              <input
                type="text"
                value={targetVersion}
                onChange={(e) => setTargetVersion(e.target.value)}
                placeholder="Target Version (e.g. 1.0.0)"
                className="bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-xs font-mono w-48"
              />

              <button
                onClick={handleRollback}
                disabled={rollingBack}
                className="px-5 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl transition shadow disabled:opacity-50"
              >
                {rollingBack ? 'Dispatching...' : 'Dispatch Fleet Rollback'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: Audit Logs */}
      {activeTab === 'audit' && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div className="pb-3 border-b border-slate-800">
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">Append-Only System Audit Logs</h2>
            <p className="text-xs text-slate-400">Chronological history of all super-admin mutations and platform events</p>
          </div>

          <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
            {auditLogs.length === 0 ? (
              <div className="text-xs text-slate-500 text-center py-6">No administrative audit logs recorded yet.</div>
            ) : (
              auditLogs.map((log) => (
                <div key={log.id} className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 flex items-center justify-between text-xs">
                  <div>
                    <div className="font-semibold text-white flex items-center gap-2">
                      <span className="text-purple-400 font-mono text-[11px]">[{log.action}]</span>
                      <span>{log.details}</span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Actor: {log.actorEmail || log.actorUserId} • {new Date(log.timestamp || Date.now()).toLocaleString()} • IP: {log.ipAddress || '127.0.0.1'}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* MODAL: Reset Password */}
      {selectedParentForReset && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl animate-fadeIn">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Key className="w-5 h-5 text-amber-400" />
                <span>Reset Parent Password</span>
              </h3>
              <button onClick={() => setSelectedParentForReset(null)} className="text-slate-500 hover:text-white">
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-400">
              Set a temporary password for <span className="font-mono text-white font-bold">{selectedParentForReset.email}</span>. Existing sessions will be invalidated immediately.
            </p>

            <form onSubmit={handleResetPassword} className="space-y-4">
              <div>
                <label className="block text-[11px] uppercase font-bold text-slate-400 mb-1">New Password</label>
                <input
                  type="password"
                  placeholder="Min 8 characters"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-xs"
                  required
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setSelectedParentForReset(null)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-xl"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={resettingPassword}
                  className="px-5 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold rounded-xl shadow disabled:opacity-50"
                >
                  {resettingPassword ? 'Resetting...' : 'Confirm Password Reset'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: Parent Details Inspector */}
      {inspectedParent && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-6 space-y-4 shadow-2xl animate-fadeIn max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-base font-bold text-white">{inspectedParent.name}</h3>
                <span className="text-xs text-slate-400 font-mono">{inspectedParent.email}</span>
              </div>
              <button onClick={() => setInspectedParent(null)} className="text-slate-500 hover:text-white">
                ✕
              </button>
            </div>

            {/* Families */}
            <div className="space-y-3">
              <h4 className="text-xs font-bold text-purple-400 uppercase tracking-wider">Associated Families & Children</h4>
              {inspectedParent.families?.map((f: any) => (
                <div key={f.familyId} className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-white text-xs">{f.familyName}</span>
                    <span className="text-[10px] bg-slate-800 px-2 py-0.5 rounded text-slate-300 font-mono">Role: {f.role}</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2">
                    {f.children?.map((c: any) => (
                      <div key={c.id} className="p-2.5 rounded-lg bg-slate-900 border border-slate-800/80 text-xs">
                        <div className="font-semibold text-slate-200">{c.name} (Age: {c.age || 'N/A'})</div>
                        <div className="text-[10px] text-slate-500 mt-1 flex items-center gap-2">
                          <span>{c.devices?.length || 0} Devices Paired</span>
                          {c.policy && <span>Policy v{c.policy.version}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-800">
              <button
                onClick={() => setInspectedParent(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-xl"
              >
                Close Inspector
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
