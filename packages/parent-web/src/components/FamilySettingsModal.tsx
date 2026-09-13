import React, { useState, useEffect } from 'react';

interface FamilySettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface FamilyMemberItem {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  role: 'OWNER' | 'PARENT' | 'VIEWER';
  mfaEnabled: boolean;
  joinedAt: string;
  isOwner: boolean;
}

interface FamilyInvitationItem {
  id: string;
  email: string;
  role: string;
  token: string;
  expiresAt: string;
  status: string;
  createdAt: string;
}

interface FamilyAuditLogItem {
  id: string;
  actorUserId: string;
  actorName: string;
  action: string;
  details: string;
  timestamp: string;
}

export const FamilySettingsModal: React.FC<FamilySettingsModalProps> = ({ isOpen, onClose }) => {
  const [tab, setTab] = useState<'members' | 'audit' | 'settings'>('members');
  const [familyData, setFamilyData] = useState<any>(null);
  const [members, setMembers] = useState<FamilyMemberItem[]>([]);
  const [invitations, setInvitations] = useState<FamilyInvitationItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<FamilyAuditLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusMsg, setStatusMsg] = useState<{ text: string; isError?: boolean } | null>(null);

  // Invite state
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'PARENT' | 'VIEWER'>('PARENT');
  const [generatedInvite, setGeneratedInvite] = useState<{ token: string; email: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Family settings form
  const [familyName, setFamilyName] = useState('');
  const [requireMfa, setRequireMfa] = useState(false);
  const [approvalRule, setApprovalRule] = useState<'ANY_PARENT' | 'OWNER_ONLY'>('ANY_PARENT');

  // Transfer ownership state
  const [transferUserId, setTransferUserId] = useState('');

  const token = localStorage.getItem('safebrowse_token');

  useEffect(() => {
    if (isOpen) {
      fetchFamilyOverview();
      fetchAuditLogs();
      setStatusMsg(null);
    }
  }, [isOpen]);

  const fetchFamilyOverview = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/family', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setFamilyData(data.family);
        setFamilyName(data.family.name);
        setRequireMfa(data.family.requireMfa);
        setApprovalRule(data.family.approvalRule || 'ANY_PARENT');
        setMembers(data.members || []);
        setInvitations(data.invitations || []);
      }
    } catch (e) {}
    setLoading(false);
  };

  const fetchAuditLogs = async () => {
    try {
      const res = await fetch('/api/family/audit', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setAuditLogs(data.logs || []);
      }
    } catch (e) {}
  };

  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMsg(null);
    try {
      const res = await fetch('/api/family/invitations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          familyId: familyData?.id,
          email: inviteEmail,
          role: inviteRole,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setGeneratedInvite(data.invitation);
        setInviteEmail('');
        fetchFamilyOverview();
        setStatusMsg({ text: `Invitation link created for ${data.invitation.email}` });
      } else {
        setStatusMsg({ text: data.error || 'Failed to send invitation', isError: true });
      }
    } catch (e: any) {
      setStatusMsg({ text: e.message, isError: true });
    }
  };

  const handleRevokeInvite = async (inviteId: string) => {
    try {
      const res = await fetch(`/api/family/invitations/${inviteId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        fetchFamilyOverview();
        setStatusMsg({ text: 'Invitation revoked.' });
      }
    } catch (e) {}
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!confirm('Are you sure you want to remove this parent from the family?')) return;
    try {
      const res = await fetch(`/api/family/members/${memberId}?familyId=${familyData?.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        fetchFamilyOverview();
        setStatusMsg({ text: 'Member removed from family.' });
      }
    } catch (e) {}
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/family', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          familyId: familyData?.id,
          name: familyName,
          requireMfa,
          approvalRule,
        }),
      });
      if (res.ok) {
        fetchFamilyOverview();
        setStatusMsg({ text: 'Family settings updated successfully!' });
      }
    } catch (e) {}
  };

  const handleTransferOwnership = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!transferUserId) return;
    if (!confirm('Are you sure you want to transfer Family Ownership? You will become a standard PARENT.')) return;
    try {
      const res = await fetch('/api/family/transfer-ownership', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          familyId: familyData?.id,
          newOwnerUserId: transferUserId,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        fetchFamilyOverview();
        setStatusMsg({ text: 'Family ownership successfully transferred.' });
      } else {
        setStatusMsg({ text: data.error || 'Failed to transfer ownership', isError: true });
      }
    } catch (e: any) {
      setStatusMsg({ text: e.message, isError: true });
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fadeIn">
      <div className="bg-slate-900 border border-slate-750 rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-slate-800 bg-slate-900/80">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-lg">
              👨‍👩‍👧‍👦
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">{familyName || 'Family Management'}</h2>
              <p className="text-xs text-slate-400">Co-parent management, roles, member invitations and activity audit</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg p-2 rounded-lg hover:bg-slate-800 transition">
            ✕
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 bg-slate-950/40 px-6 gap-2 pt-2">
          {[
            { id: 'members', label: '👨‍👩‍👧 Parents & Co-Parents', count: members.length },
            { id: 'audit', label: '📜 Family Audit Feed', count: auditLogs.length },
            { id: 'settings', label: '⚙️ Family Settings', count: undefined },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => { setTab(t.id as any); setStatusMsg(null); }}
              className={`pb-3 px-3 text-sm font-semibold border-b-2 transition flex items-center gap-2 ${
                tab === t.id
                  ? 'border-emerald-500 text-emerald-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>{t.label}</span>
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

        {/* Body Content */}
        <div className="p-6 overflow-y-auto space-y-6">
          {loading ? (
            <div className="py-12 text-center text-slate-400">Loading family data...</div>
          ) : (
            <>
              {/* TAB 1: Members & Invitations */}
              {tab === 'members' && (
                <div className="space-y-6">
                  {/* Co-Parent Members List */}
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-white">Family Parents & Guardians</h3>
                      <p className="text-xs text-slate-400">Authorized guardians who can configure protection and approve requests</p>
                    </div>
                    <button
                      onClick={() => setShowInviteModal(true)}
                      className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg transition flex items-center gap-1.5 shadow-md shadow-emerald-600/20"
                    >
                      <span>+</span>
                      <span>Invite Parent</span>
                    </button>
                  </div>

                  <div className="space-y-2">
                    {members.map((m) => (
                      <div
                        key={m.memberId}
                        className="p-4 rounded-xl border border-slate-800 bg-slate-800/40 flex items-center justify-between"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-slate-700 flex items-center justify-center font-bold text-white text-sm">
                            {m.name.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <div className="text-sm font-semibold text-white flex items-center gap-2">
                              <span>{m.name}</span>
                              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                                m.role === 'OWNER'
                                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                  : 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                              }`}>
                                {m.role}
                              </span>
                              {m.mfaEnabled && (
                                <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded font-mono">
                                  MFA ✓
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-slate-400">
                              {m.email} • Joined {new Date(m.joinedAt).toLocaleDateString()}
                            </div>
                          </div>
                        </div>

                        {!m.isOwner && (
                          <button
                            onClick={() => handleRemoveMember(m.memberId)}
                            className="text-xs text-slate-400 hover:text-rose-400 px-2 py-1 rounded hover:bg-slate-800 transition"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Pending Invitations */}
                  {invitations.length > 0 && (
                    <div className="pt-4 border-t border-slate-800 space-y-3">
                      <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider">Pending Co-Parent Invitations</h4>
                      <div className="space-y-2">
                        {invitations.map((inv) => (
                          <div
                            key={inv.id}
                            className="p-3 bg-slate-900/60 border border-amber-500/30 rounded-xl flex items-center justify-between"
                          >
                            <div>
                              <div className="text-sm font-medium text-amber-300">{inv.email}</div>
                              <div className="text-xs text-slate-400">
                                Role: {inv.role} • Expires: {new Date(inv.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => {
                                  navigator.clipboard.writeText(`http://localhost:1001/invite/${inv.token}`);
                                  setStatusMsg({ text: 'Invite link copied to clipboard!' });
                                }}
                                className="px-2 py-1 text-xs text-indigo-400 hover:bg-slate-800 rounded transition"
                              >
                                Copy Link
                              </button>
                              <button
                                onClick={() => handleRevokeInvite(inv.id)}
                                className="text-xs text-rose-400 hover:bg-slate-800 px-2 py-1 rounded transition"
                              >
                                Revoke
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Invite Sub-Modal */}
                  {showInviteModal && (
                    <div className="p-4 bg-slate-800/80 border border-emerald-500/40 rounded-xl space-y-4 animate-fadeIn">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-bold text-white">Invite a Co-Parent</h4>
                        <button onClick={() => { setShowInviteModal(false); setGeneratedInvite(null); }} className="text-slate-400 hover:text-white">✕</button>
                      </div>

                      {!generatedInvite ? (
                        <form onSubmit={handleSendInvite} className="space-y-3">
                          <div>
                            <label className="block text-xs font-semibold text-slate-300 uppercase mb-1">Co-Parent Email</label>
                            <input
                              type="email"
                              value={inviteEmail}
                              onChange={(e) => setInviteEmail(e.target.value)}
                              placeholder="spouse@example.com"
                              required
                              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-semibold text-slate-300 uppercase mb-1">Permission Role</label>
                            <select
                              value={inviteRole}
                              onChange={(e) => setInviteRole(e.target.value as any)}
                              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
                            >
                              <option value="PARENT">PARENT (Manage rules, approve requests, pause internet)</option>
                              <option value="VIEWER">VIEWER (View status and activity only)</option>
                            </select>
                          </div>
                          <div className="flex justify-end gap-2 pt-2">
                            <button
                              type="button"
                              onClick={() => setShowInviteModal(false)}
                              className="px-3 py-1.5 text-xs text-slate-400 hover:text-white"
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg transition"
                            >
                              Generate Secure Invitation Link
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div className="space-y-3">
                          <div className="text-xs text-emerald-300 font-semibold">
                            ✅ Secure single-use invitation generated for {generatedInvite.email}:
                          </div>
                          <div className="flex items-center gap-2 bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                            <input
                              type="text"
                              readOnly
                              value={`http://localhost:1001/invite/${generatedInvite.token}`}
                              className="bg-transparent text-xs text-indigo-300 font-mono flex-1 focus:outline-none"
                            />
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(`http://localhost:1001/invite/${generatedInvite.token}`);
                                setCopied(true);
                                setTimeout(() => setCopied(false), 2000);
                              }}
                              className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded transition"
                            >
                              {copied ? 'Copied! ✓' : 'Copy'}
                            </button>
                          </div>
                          <p className="text-[11px] text-slate-400">
                            This link expires in 48 hours and can only be used once. Send it directly to your co-parent.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* TAB 2: Family Audit Feed */}
              {tab === 'audit' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-white">Family Parental Actions Timeline</h3>
                    <span className="text-xs text-slate-400">Audit trail of who performed key actions</span>
                  </div>

                  <div className="space-y-2">
                    {auditLogs.length === 0 ? (
                      <div className="text-center py-8 text-slate-400 text-xs">No parental actions recorded yet.</div>
                    ) : (
                      auditLogs.map((log) => (
                        <div
                          key={log.id}
                          className="p-3 bg-slate-800/40 border border-slate-800 rounded-xl flex items-start gap-3"
                        >
                          <div className="text-lg">
                            {log.action.includes('REQUEST') ? '📨' : log.action.includes('MFA') ? '🛡️' : '👨‍👩‍👧'}
                          </div>
                          <div className="flex-1">
                            <div className="text-xs font-semibold text-white">
                              {log.actorName} • <span className="text-slate-400 font-normal">{new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            </div>
                            <div className="text-xs text-slate-300 mt-0.5">{log.details}</div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              {/* TAB 3: Family Settings & Danger Zone */}
              {tab === 'settings' && (
                <div className="space-y-6">
                  <form onSubmit={handleSaveSettings} className="space-y-4 max-w-lg">
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 uppercase mb-1">Family Display Name</label>
                      <input
                        type="text"
                        value={familyName}
                        onChange={(e) => setFamilyName(e.target.value)}
                        required
                        className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
                      />
                    </div>

                    <div className="pt-2 border-t border-slate-800 space-y-3">
                      <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider">Family Security & Approval Rules</h4>
                      
                      <label className="flex items-start gap-3 p-3 rounded-lg bg-slate-800/40 border border-slate-800 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={requireMfa}
                          onChange={(e) => setRequireMfa(e.target.checked)}
                          className="mt-1 rounded bg-slate-800 border-slate-700 text-emerald-600 focus:ring-emerald-500"
                        />
                        <div>
                          <div className="text-sm font-semibold text-white">Require MFA for All Co-Parents</div>
                          <div className="text-xs text-slate-400">All parents must have 2-Factor Authentication enabled to manage rules</div>
                        </div>
                      </label>

                      <div>
                        <label className="block text-xs font-semibold text-slate-300 uppercase mb-1">Parent Approval Rule</label>
                        <select
                          value={approvalRule}
                          onChange={(e) => setApprovalRule(e.target.value as any)}
                          className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
                        >
                          <option value="ANY_PARENT">Any Parent can approve requests (Recommended)</option>
                          <option value="OWNER_ONLY">Family Owner only</option>
                        </select>
                      </div>
                    </div>

                    <button
                      type="submit"
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg transition"
                    >
                      Save Family Settings
                    </button>
                  </form>

                  {/* Danger Zone */}
                  <div className="pt-6 border-t border-rose-500/20 space-y-4">
                    <h4 className="text-xs font-bold text-rose-400 uppercase tracking-wider">Danger Zone</h4>
                    <form onSubmit={handleTransferOwnership} className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl space-y-3">
                      <div className="text-sm font-semibold text-white">Transfer Family Ownership</div>
                      <p className="text-xs text-slate-300">
                        Transfer the Family Owner role to another co-parent. You will retain normal PARENT permissions.
                      </p>
                      <div className="flex gap-2">
                        <select
                          value={transferUserId}
                          onChange={(e) => setTransferUserId(e.target.value)}
                          className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-white text-xs flex-1"
                        >
                          <option value="">Select Co-Parent...</option>
                          {members.filter((m) => !m.isOwner).map((m) => (
                            <option key={m.userId} value={m.userId}>
                              {m.name} ({m.email})
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          disabled={!transferUserId}
                          className="px-4 py-1.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-lg transition disabled:opacity-50"
                        >
                          Transfer
                        </button>
                      </div>
                    </form>
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
