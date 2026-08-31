import React, { useState, useEffect } from 'react';
import { useToast } from '../components/Toast';
import { api } from '../api/client';

export const FamilyManagementPage: React.FC = () => {
  const { showToast } = useToast();
  const [familyData, setFamilyData] = useState<any>(null);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Invite state
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'PARENT' | 'VIEWER'>('PARENT');
  const [generatedInvite, setGeneratedInvite] = useState<any>(null);
  const [inviting, setInviting] = useState(false);

  // Ownership transfer
  const [newOwnerId, setNewOwnerId] = useState('');
  const [showTransferConfirm, setShowTransferConfirm] = useState(false);
  const [transferring, setTransferring] = useState(false);

  useEffect(() => {
    fetchFamily();
  }, []);

  const fetchFamily = async () => {
    setLoading(true);
    try {
      const [fam, aData] = await Promise.all([
        api.getFamily().catch(() => null),
        api.getFamilyAudit().catch(() => ({ logs: [] })),
      ]);
      if (fam) setFamilyData(fam);
      if (aData) setAuditLogs(aData.logs || []);
    } catch (e) {
      console.error('Error fetching family:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!familyData) return;
    setInviting(true);
    try {
      const data = await api.inviteParent(familyData.family.id, inviteEmail, inviteRole);
      setGeneratedInvite(data.invitation);
      setInviteEmail('');
      showToast('Co-Parent invitation created! Copy the link below.', 'success');
      fetchFamily();
    } catch (e: any) {
      showToast(e.message || 'Failed to send invite', 'error');
    } finally {
      setInviting(false);
    }
  };

  const handleRevokeInvite = async (id: string) => {
    try {
      await api.revokeInvitation(id);
      showToast('Invitation revoked.', 'info');
      fetchFamily();
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!familyData) return;
    try {
      await api.removeFamilyMember(memberId, familyData.family.id);
      showToast('Member removed from family.', 'info');
      fetchFamily();
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleTransferOwnership = async () => {
    if (!familyData || !newOwnerId) return;
    setTransferring(true);
    try {
      await api.transferOwnership(familyData.family.id, newOwnerId);
      showToast('Family ownership transferred successfully!', 'success');
      setShowTransferConfirm(false);
      fetchFamily();
    } catch (e: any) {
      showToast(e.message || 'Transfer failed', 'error');
    } finally {
      setTransferring(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-slate-400">Loading family settings...</div>;
  }

  const isOwner = familyData?.myRole === 'OWNER';

  return (
    <div className="max-w-4xl space-y-8 animate-fadeIn">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-extrabold text-white tracking-tight">{familyData?.family?.name || 'Family Workspace'}</h1>
        <p className="text-xs text-slate-400">Manage co-parents, child policies, family activity logs, and roles</p>
      </div>

      {/* Section 1: Parents & Guardians */}
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-xl">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div>
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">Parents & Guardians</h2>
            <p className="text-xs text-slate-400">Co-parents who have shared management over the family's children</p>
          </div>
          <span className="text-xs bg-slate-800 text-slate-300 px-3 py-1 rounded-full font-bold">
            {familyData?.members?.length || 1} Parent{familyData?.members?.length > 1 ? 's' : ''}
          </span>
        </div>

        <div className="space-y-2.5">
          {familyData?.members?.map((m: any) => (
            <div key={m.id} className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-sm font-bold text-emerald-400">
                  {m.name ? m.name.charAt(0).toUpperCase() : 'P'}
                </div>
                <div>
                  <div className="text-sm font-bold text-white flex items-center gap-2">
                    <span>{m.name}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                      m.role === 'OWNER'
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                        : 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                    }`}>
                      {m.role}
                    </span>
                    {m.mfaEnabled && (
                      <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full">
                        MFA ✓
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-400">{m.email} • Joined {new Date(m.joinedAt || Date.now()).toLocaleDateString()}</div>
                </div>
              </div>

              {isOwner && m.role !== 'OWNER' && (
                <button
                  onClick={() => handleRemoveMember(m.id)}
                  className="text-xs font-semibold text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 px-3 py-1.5 rounded-lg border border-rose-500/30 transition"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Section 2: Invite Co-Parent Form */}
      {isOwner && (
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-xl">
          <div className="pb-3 border-b border-slate-800">
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">Invite Co-Parent</h2>
            <p className="text-xs text-slate-400">Send an expiring, one-time invitation link to your spouse or co-guardian</p>
          </div>

          <form onSubmit={handleSendInvite} className="space-y-4 max-w-lg">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase mb-1">Co-Parent Email</label>
              <input
                type="email"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="spouse@example.com"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase mb-1">Assigned Role</label>
              <div className="grid grid-cols-2 gap-3">
                <label className={`p-3 rounded-xl border cursor-pointer transition ${
                  inviteRole === 'PARENT'
                    ? 'bg-emerald-500/10 border-emerald-500/40 text-white'
                    : 'bg-slate-950/40 border-slate-800 text-slate-400'
                }`}>
                  <input
                    type="radio"
                    name="role"
                    checked={inviteRole === 'PARENT'}
                    onChange={() => setInviteRole('PARENT')}
                    className="sr-only"
                  />
                  <div className="text-xs font-bold text-emerald-400">Parent (Full Controls)</div>
                  <div className="text-[11px] text-slate-400 mt-1">Can approve requests, edit website rules, and pause internet</div>
                </label>

                <label className={`p-3 rounded-xl border cursor-pointer transition ${
                  inviteRole === 'VIEWER'
                    ? 'bg-indigo-500/10 border-indigo-500/40 text-white'
                    : 'bg-slate-950/40 border-slate-800 text-slate-400'
                }`}>
                  <input
                    type="radio"
                    name="role"
                    checked={inviteRole === 'VIEWER'}
                    onChange={() => setInviteRole('VIEWER')}
                    className="sr-only"
                  />
                  <div className="text-xs font-bold text-indigo-400">Viewer (Read Only)</div>
                  <div className="text-[11px] text-slate-400 mt-1">Can view protection status and child activity, cannot change rules</div>
                </label>
              </div>
            </div>

            <button
              type="submit"
              disabled={inviting}
              className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition shadow-lg shadow-emerald-600/20 disabled:opacity-50"
            >
              {inviting ? 'Generating...' : 'Generate 48h Invitation Link'}
            </button>
          </form>

          {/* Generated Invite Box */}
          {generatedInvite && (
            <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-xl space-y-2.5 animate-fadeIn">
              <div className="text-xs font-bold text-emerald-300">✓ Invitation Generated for {generatedInvite.email}</div>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={`http://localhost:1001/invite/${generatedInvite.token}`}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-300 font-mono flex-1 select-all"
                />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(`http://localhost:1001/invite/${generatedInvite.token}`);
                    showToast('Invitation link copied!', 'success');
                  }}
                  className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg transition"
                >
                  Copy Link
                </button>
              </div>
              <div className="text-[11px] text-slate-400">Expires: {new Date(generatedInvite.expiresAt || Date.now()).toLocaleDateString()} (Single use)</div>
            </div>
          )}
        </section>
      )}

      {/* Section 3: Pending Invitations */}
      {familyData?.invitations?.length > 0 && (
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-xl">
          <div className="pb-3 border-b border-slate-800">
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">Pending Invitations</h2>
            <p className="text-xs text-slate-400">Invitations waiting to be claimed by recipients</p>
          </div>

          <div className="space-y-2">
            {familyData.invitations.map((inv: any) => (
              <div key={inv.id} className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-white flex items-center gap-2">
                    <span>{inv.email}</span>
                    <span className="text-[10px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded-full font-bold">
                      {inv.status}
                    </span>
                    <span className="text-[10px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full">
                      {inv.role}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400">Expires: {new Date(inv.expiresAt || Date.now()).toLocaleDateString()}</div>
                </div>

                <button
                  onClick={() => handleRevokeInvite(inv.id)}
                  className="text-xs font-semibold text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 px-3 py-1 rounded border border-rose-500/30 transition"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Section 4: Family Activity Audit Feed */}
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-xl">
        <div className="pb-3 border-b border-slate-800">
          <h2 className="text-sm font-bold text-white uppercase tracking-wider">Family Audit Trail</h2>
          <p className="text-xs text-slate-400">Immutable record of all management, policy, and approval actions</p>
        </div>

        <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
          {auditLogs.length === 0 ? (
            <div className="text-xs text-slate-500 text-center py-4">No audit logs recorded yet.</div>
          ) : (
            auditLogs.map((l) => (
              <div key={l.id} className="p-3 rounded-xl bg-slate-950/50 border border-slate-800 flex items-center justify-between text-xs">
                <div>
                  <div className="font-semibold text-white flex items-center gap-2">
                    <span className="text-emerald-400 font-mono text-[11px]">[{l.action}]</span>
                    <span>{l.details}</span>
                  </div>
                  <div className="text-[11px] text-slate-400">By {l.actorName} • {new Date(l.timestamp || Date.now()).toLocaleString()}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Section 5: Transfer Family Ownership */}
      {isOwner && familyData?.members?.length > 1 && (
        <section className="bg-slate-900 border border-rose-900/40 rounded-2xl p-6 space-y-4 shadow-xl">
          <div className="pb-3 border-b border-slate-800">
            <h2 className="text-sm font-bold text-rose-400 uppercase tracking-wider">Transfer Family Ownership</h2>
            <p className="text-xs text-slate-400">Transfer primary ownership to another co-parent. You will become a standard PARENT.</p>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
            <select
              value={newOwnerId}
              onChange={(e) => setNewOwnerId(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-xs focus:outline-none focus:border-rose-500 flex-1"
            >
              <option value="">-- Select New Family Owner --</option>
              {familyData.members
                .filter((m: any) => m.role !== 'OWNER')
                .map((m: any) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name} ({m.email})
                  </option>
                ))}
            </select>

            <button
              onClick={() => setShowTransferConfirm(true)}
              disabled={!newOwnerId}
              className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl transition disabled:opacity-50"
            >
              Transfer Ownership
            </button>
          </div>

          {showTransferConfirm && (
            <div className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl space-y-3 animate-fadeIn">
              <div className="text-xs font-bold text-rose-300">⚠️ Confirm Irreversible Ownership Transfer</div>
              <p className="text-xs text-slate-300">
                Are you sure you want to transfer family ownership? Only the new owner will be able to delete the family or remove co-parents.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowTransferConfirm(false)}
                  className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold rounded-lg"
                >
                  Cancel
                </button>
                <button
                  onClick={handleTransferOwnership}
                  disabled={transferring}
                  className="px-4 py-1.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-lg shadow"
                >
                  {transferring ? 'Transferring...' : 'Yes, Transfer Ownership'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
};
