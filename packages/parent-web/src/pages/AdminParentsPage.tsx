import React, { useEffect, useState } from 'react';
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
  ShieldOff,
  UserX,
  UserRoundCheck,
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

  const [selectedParentForReset, setSelectedParentForReset] = useState<any>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resettingPassword, setResettingPassword] = useState(false);

  const [inspectedParent, setInspectedParent] = useState<any>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  const [selectedParentForDisable, setSelectedParentForDisable] = useState<any>(null);
  const [disableReason, setDisableReason] = useState('');
  const [updatingAccountStatus, setUpdatingAccountStatus] = useState(false);

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
        api.getAdminParents(true).catch((e) => {
          if (e.message?.includes('Forbidden')) throw e;
          return { parents: [] };
        }),
        api.getAdminMetrics(true).catch(() => null),
        api.getAdminAudit(true).catch(() => ({ logs: [] })),
      ]);
      if (parentsRes?.parents) setParents(parentsRes.parents);
      if (metricsRes) setMetrics(metricsRes);
      if (auditRes?.logs) setAuditLogs(auditRes.logs);
    } catch (e: any) {
      if (e.message?.includes('Forbidden')) setForbidden(true);
      console.error('Failed to load admin data:', e);
    } finally {
      setLoading(false);
    }
  };

  const postAdminAction = async (url: string, body?: any) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: api.getHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    api.invalidateCache('/api/admin/parents');
    return data;
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
    if (!window.confirm(`Are you sure you want to change ${parent.email} role to ${newRole}?`)) return;
    try {
      await api.adminChangeUserRole(parent.id, newRole);
      showToast(`Role updated to ${newRole} for ${parent.email}`, 'success');
      fetchAdminData();
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleDisableMfa = async (parent: any) => {
    if (!window.confirm(`Are you sure you want to disable MFA for ${parent.email}? Existing sessions will be invalidated.`)) return;
    try {
      await api.adminDisableParentMfa(parent.id);
      showToast(`MFA disabled for ${parent.email}`, 'success');
      fetchAdminData();
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleDisableUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedParentForDisable) return;
    const reason = disableReason.trim();
    if (!reason) {
      showToast('A disable reason is required', 'error');
      return;
    }
    setUpdatingAccountStatus(true);
    try {
      await postAdminAction(`/api/admin/parents/${selectedParentForDisable.id}/disable`, { reason });
      showToast(`Account disabled for ${selectedParentForDisable.email}`, 'success');
      setSelectedParentForDisable(null);
      setDisableReason('');
      await fetchAdminData();
    } catch (e: any) {
      showToast(e.message, 'error');
    } finally {
      setUpdatingAccountStatus(false);
    }
  };

  const handleEnableUser = async (parent: any) => {
    if (!window.confirm(`Enable ${parent.email}? The user will need to sign in again; old sessions will remain revoked.`)) return;
    setUpdatingAccountStatus(true);
    try {
      await postAdminAction(`/api/admin/parents/${parent.id}/enable`);
      showToast(`Account enabled for ${parent.email}`, 'success');
      await fetchAdminData();
    } catch (e: any) {
      showToast(e.message, 'error');
    } finally {
      setUpdatingAccountStatus(false);
    }
  };

  const handleInspectParent = async (parentId: string) => {
    setLoadingDetails(true);
    try {
      const details = await api.getAdminParentDetails(parentId, true);
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
      const data = await api.dispatchAdminRollback(targetVersion, 'Emergency fleet rollback from System Admin Console');
      showToast(`Rollback dispatched to ${data.result?.affectedDevices || 'all'} devices!`, 'success');
      fetchAdminData();
    } catch (e: any) {
      showToast(e.message || 'Rollback failed', 'error');
    } finally {
      setRollingBack(false);
    }
  };

  if (loading) return <div className="p-12 text-center text-slate-400">Loading System Administrator Console...</div>;

  if (forbidden) {
    return (
      <div className="max-w-2xl mx-auto my-12 p-8 bg-slate-900 border border-rose-900/50 rounded-2xl text-center space-y-4 shadow-2xl">
        <ShieldAlert className="w-8 h-8 text-rose-400 mx-auto" />
        <h2 className="text-lg font-bold text-white">403 — System Administrator Access Required</h2>
      </div>
    );
  }

  const filteredParents = parents.filter((p) =>
    p.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="max-w-7xl mx-auto space-y-6 animate-fadeIn pb-12">
      <div className="bg-slate-900 border border-purple-500/30 rounded-2xl p-6 shadow-xl flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-white">System Administrator Console</h1>
          <p className="text-xs text-slate-400 mt-1">Manage parent accounts, account status, fleet health and audit history.</p>
        </div>
        <button onClick={fetchAdminData} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl flex items-center gap-2">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh All
        </button>
      </div>

      {metrics && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Metric label="Registered Parents" value={metrics.usersCount || parents.length} />
          <Metric label="Total Families" value={metrics.familiesCount || 0} />
          <Metric label="Protected Devices" value={metrics.healthBreakdown?.protected || 0} />
          <Metric label="Fleet Health" value={metrics.policySyncSuccessRate || '100%'} />
        </div>
      )}

      <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
        <TabButton active={activeTab === 'parents'} onClick={() => setActiveTab('parents')} icon={<Users className="w-4 h-4" />} label={`Parent Management (${parents.length})`} />
        <TabButton active={activeTab === 'fleet'} onClick={() => setActiveTab('fleet')} icon={<Activity className="w-4 h-4" />} label="Fleet Health & Rollback" />
        <TabButton active={activeTab === 'audit'} onClick={() => setActiveTab('audit')} icon={<ShieldCheck className="w-4 h-4" />} label={`System Audit Logs (${auditLogs.length})`} />
      </div>

      {activeTab === 'parents' && (
        <div className="space-y-4">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search parents by email, name, or User ID..." className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-xs text-white" />
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950/80 text-slate-400 text-[10px] uppercase border-b border-slate-800 font-bold">
                  <tr>
                    <th className="py-3.5 px-4">Parent / User</th>
                    <th className="py-3.5 px-4">System Role</th>
                    <th className="py-3.5 px-4">Account Status</th>
                    <th className="py-3.5 px-4">Email</th>
                    <th className="py-3.5 px-4">MFA</th>
                    <th className="py-3.5 px-4">Families & Children</th>
                    <th className="py-3.5 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredParents.length === 0 ? (
                    <tr><td colSpan={7} className="py-8 text-center text-slate-500">No parents found.</td></tr>
                  ) : filteredParents.map((parent) => (
                    <tr key={parent.id} className="hover:bg-slate-800/40 transition">
                      <td className="py-3.5 px-4">
                        <div className="font-bold text-white">{parent.name}</div>
                        <div className="text-slate-400 font-mono text-[11px]">{parent.email}</div>
                        <div className="text-[10px] text-slate-500 font-mono">ID: {parent.id}</div>
                      </td>
                      <td className="py-3.5 px-4"><RoleBadge role={parent.systemRole} /></td>
                      <td className="py-3.5 px-4">
                        <StatusBadge status={parent.status || 'ACTIVE'} />
                        {parent.status === 'DISABLED' && parent.disabledReason && (
                          <div className="text-[10px] text-slate-500 mt-1 max-w-48 truncate" title={parent.disabledReason}>{parent.disabledReason}</div>
                        )}
                      </td>
                      <td className="py-3.5 px-4">
                        {parent.emailVerified ? (
                          <span className="inline-flex items-center gap-1 text-emerald-400"><CheckCircle className="w-3.5 h-3.5" /> Verified</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-1 text-amber-400"><XCircle className="w-3.5 h-3.5" /> Pending</span>
                            <button onClick={() => handleVerifyEmail(parent)} className="text-[10px] text-emerald-300">Verify</button>
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-4">{parent.mfaEnabled ? <span className="text-emerald-400">Enabled</span> : <span className="text-slate-500">Disabled</span>}</td>
                      <td className="py-3.5 px-4">
                        {parent.families?.length ? parent.families.map((f: any) => (
                          <div key={f.familyId} className="text-[11px] mb-1">
                            <span className="font-semibold text-slate-300">{f.familyName}</span>
                            <span className="text-slate-500 ml-1">({f.role})</span>
                            <div className="text-[10px] text-slate-400">{f.children?.length || 0} Children • {f.children?.reduce((a: number, c: any) => a + (c.deviceCount || 0), 0) || 0} Devices</div>
                          </div>
                        )) : <span className="text-slate-500">None</span>}
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <div className="flex justify-end gap-2 flex-wrap">
                          <ActionButton title="Inspect" onClick={() => handleInspectParent(parent.id)} icon={<Eye className="w-3.5 h-3.5" />} />
                          <ActionButton title="Reset Password" onClick={() => { setSelectedParentForReset(parent); setNewPassword(''); }} icon={<Key className="w-3.5 h-3.5" />} />
                          <ActionButton title="Promote / Demote Role" onClick={() => handleToggleRole(parent)} icon={<UserCheck className="w-3.5 h-3.5" />} />
                          {parent.mfaEnabled && <ActionButton title="Disable MFA" onClick={() => handleDisableMfa(parent)} icon={<ShieldOff className="w-3.5 h-3.5" />} />}
                          {(parent.status || 'ACTIVE') === 'ACTIVE' ? (
                            <button disabled={updatingAccountStatus} onClick={() => { setSelectedParentForDisable(parent); setDisableReason(''); }} title="Disable User" className="p-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 disabled:opacity-50"><UserX className="w-3.5 h-3.5" /></button>
                          ) : (
                            <button disabled={updatingAccountStatus} onClick={() => handleEnableUser(parent)} title="Enable User" className="p-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 disabled:opacity-50"><UserRoundCheck className="w-3.5 h-3.5" /></button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'fleet' && (
        <div className="bg-slate-900 border border-rose-900/40 rounded-2xl p-6 shadow-xl space-y-4">
          <h2 className="text-sm font-bold text-rose-400 flex items-center gap-2"><RotateCcw className="w-4 h-4" /> Emergency Fleet Version Rollback</h2>
          <div className="flex gap-3">
            <input value={targetVersion} onChange={(e) => setTargetVersion(e.target.value)} className="bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-xs font-mono w-48" />
            <button onClick={handleRollback} disabled={rollingBack} className="px-5 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl disabled:opacity-50">{rollingBack ? 'Dispatching...' : 'Dispatch Fleet Rollback'}</button>
          </div>
        </div>
      )}

      {activeTab === 'audit' && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-3">
          {auditLogs.length === 0 ? <div className="text-xs text-slate-500 text-center py-6">No administrative audit logs recorded yet.</div> : auditLogs.map((log) => (
            <div key={log.id} className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 text-xs">
              <div className="font-semibold text-white"><span className="text-purple-400 font-mono">[{log.action}]</span> {log.details}</div>
              <div className="text-[11px] text-slate-400 mt-1">Actor: {log.actorEmail || log.actorUserId} • {new Date(log.timestamp || Date.now()).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}

      {selectedParentForReset && (
        <Modal title={`Reset Password — ${selectedParentForReset.email}`} onClose={() => setSelectedParentForReset(null)}>
          <form onSubmit={handleResetPassword} className="space-y-4">
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="New password (min 8 characters)" className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-xs" required />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setSelectedParentForReset(null)} className="px-4 py-2 bg-slate-800 text-slate-300 text-xs rounded-xl">Cancel</button>
              <button type="submit" disabled={resettingPassword} className="px-5 py-2 bg-amber-500 text-slate-950 text-xs font-bold rounded-xl disabled:opacity-50">{resettingPassword ? 'Resetting...' : 'Reset Password'}</button>
            </div>
          </form>
        </Modal>
      )}

      {selectedParentForDisable && (
        <Modal title={`Disable ${selectedParentForDisable.email}?`} onClose={() => setSelectedParentForDisable(null)}>
          <form onSubmit={handleDisableUser} className="space-y-4">
            <div className="text-xs text-slate-300 space-y-1 bg-slate-950 border border-slate-800 rounded-xl p-4">
              <div>• Login will be blocked immediately.</div>
              <div>• Active web sessions will be revoked.</div>
              <div>• Family, child, policy and device data will remain intact.</div>
              <div>• Child device protection will continue.</div>
            </div>
            <div>
              <label className="block text-[11px] uppercase font-bold text-slate-400 mb-1">Reason (required)</label>
              <textarea value={disableReason} onChange={(e) => setDisableReason(e.target.value)} rows={3} placeholder="Why is this account being disabled?" className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-xs" required />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setSelectedParentForDisable(null)} className="px-4 py-2 bg-slate-800 text-slate-300 text-xs rounded-xl">Cancel</button>
              <button type="submit" disabled={updatingAccountStatus || !disableReason.trim()} className="px-5 py-2 bg-rose-600 text-white text-xs font-bold rounded-xl disabled:opacity-50">{updatingAccountStatus ? 'Disabling...' : 'Disable User'}</button>
            </div>
          </form>
        </Modal>
      )}

      {inspectedParent && (
        <Modal title={`${inspectedParent.name} — ${inspectedParent.email}`} onClose={() => setInspectedParent(null)} wide>
          <div className="space-y-4 text-xs">
            <div className="flex gap-3"><RoleBadge role={inspectedParent.systemRole} /><StatusBadge status={inspectedParent.status || 'ACTIVE'} /></div>
            {inspectedParent.status === 'DISABLED' && (
              <div className="bg-rose-950/20 border border-rose-900/40 rounded-xl p-3 text-slate-300">
                <div><strong>Disabled:</strong> {inspectedParent.disabledAt ? new Date(inspectedParent.disabledAt).toLocaleString() : 'N/A'}</div>
                <div><strong>Reason:</strong> {inspectedParent.disabledReason || 'N/A'}</div>
              </div>
            )}
            {inspectedParent.families?.map((f: any) => (
              <div key={f.familyId} className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                <div className="font-bold text-white">{f.familyName} <span className="text-slate-500">({f.role})</span></div>
                <div className="mt-2 space-y-1">{f.children?.map((c: any) => <div key={c.id} className="text-slate-300">{c.name} • {c.devices?.length || 0} devices {c.policy ? `• Policy v${c.policy.version}` : ''}</div>)}</div>
              </div>
            ))}
            {loadingDetails && <div className="text-slate-500">Loading details...</div>}
          </div>
        </Modal>
      )}
    </div>
  );
};

const Metric = ({ label, value }: { label: string; value: any }) => (
  <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
    <span className="text-[10px] uppercase font-bold text-slate-500">{label}</span>
    <div className="text-2xl font-extrabold text-white mt-1">{value}</div>
  </div>
);

const TabButton = ({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) => (
  <button onClick={onClick} className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition ${active ? 'bg-purple-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}>{icon}{label}</button>
);

const RoleBadge = ({ role }: { role: string }) => (
  <span className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold border ${role === 'SYSTEM_ADMIN' ? 'bg-purple-500/20 text-purple-300 border-purple-500/30' : 'bg-slate-800 text-slate-300 border-slate-700'}`}>{role}</span>
);

const StatusBadge = ({ status }: { status: string }) => (
  <span className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold border ${status === 'DISABLED' ? 'bg-rose-500/15 text-rose-300 border-rose-500/30' : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'}`}>{status}</span>
);

const ActionButton = ({ title, onClick, icon }: { title: string; onClick: () => void; icon: React.ReactNode }) => (
  <button onClick={onClick} title={title} className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition">{icon}</button>
);

const Modal = ({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) => (
  <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
    <div className={`bg-slate-900 border border-slate-800 rounded-2xl w-full p-6 space-y-4 shadow-2xl max-h-[85vh] overflow-y-auto ${wide ? 'max-w-2xl' : 'max-w-md'}`}>
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <h3 className="text-base font-bold text-white">{title}</h3>
        <button onClick={onClose} className="text-slate-500 hover:text-white">✕</button>
      </div>
      {children}
    </div>
  </div>
);
