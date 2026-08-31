import React, { useState, useEffect } from 'react';
import { Policy, PolicyRule } from '../api/client';
import { ShieldAlert, ShieldCheck, Clock, Trash2, Plus, Globe, Sparkles } from 'lucide-react';

interface WebsiteRulesProps {
  childName: string;
  policy: Policy | null;
  onAddRule: (domain: string, action: 'BLOCK' | 'ALLOW', reason?: string) => void;
  onRemoveRule: (ruleId: string) => void;
  showAddModal: boolean;
  setShowAddModal: (show: boolean) => void;
}

export const WebsiteRules: React.FC<WebsiteRulesProps> = ({
  childName,
  policy,
  onAddRule,
  onRemoveRule,
  showAddModal,
  setShowAddModal,
}) => {
  const [activeTab, setActiveTab] = useState<'blocked' | 'allowed' | 'temporary'>('blocked');
  const [newDomain, setNewDomain] = useState('');
  const [newAction, setNewAction] = useState<'BLOCK' | 'ALLOW'>('BLOCK');
  const [newReason, setNewReason] = useState('');
  const [now, setNow] = useState(Date.now());

  // Tick clock for countdowns
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const rules = policy?.rules || [];
  const blockedRules = rules.filter((r) => r.action === 'BLOCK');
  const allowedRules = rules.filter((r) => r.action === 'ALLOW');
  const temporaryRules = rules.filter((r) => {
    if (r.action !== 'TEMPORARY_ALLOW') return false;
    if (!r.expiresAt) return false;
    return new Date(r.expiresAt).getTime() > now;
  });

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDomain.trim()) return;
    onAddRule(newDomain.trim(), newAction, newReason.trim() || undefined);
    setNewDomain('');
    setNewReason('');
    setShowAddModal(false);
  };

  const formatRemainingTime = (expiresAt: string) => {
    const diff = new Date(expiresAt).getTime() - now;
    if (diff <= 0) return 'Expiring now...';
    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    if (minutes > 60) {
      const hours = Math.floor(minutes / 60);
      return `${hours}h ${minutes % 60}m left`;
    }
    return `${minutes}m ${seconds}s left`;
  };

  return (
    <div className="bg-white rounded-3xl p-6 sm:p-7 shadow-sm border border-slate-200/80">
      {/* Header & Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-6 border-b border-slate-100">
        <div>
          <h3 className="text-xl font-black text-slate-900 tracking-tight">Website Rules</h3>
          <p className="text-xs text-slate-500 font-medium mt-0.5">
            Single policy applied automatically to all devices used by {childName}.
          </p>
        </div>

        <div className="flex items-center space-x-2">
          {/* Tabs */}
          <div className="bg-slate-100 p-1 rounded-2xl flex space-x-1">
            <button
              onClick={() => setActiveTab('blocked')}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center space-x-1.5 ${
                activeTab === 'blocked'
                  ? 'bg-red-500 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              <span>Blocked ({blockedRules.length})</span>
            </button>

            <button
              onClick={() => setActiveTab('allowed')}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center space-x-1.5 ${
                activeTab === 'allowed'
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Allowed ({allowedRules.length})</span>
            </button>

            <button
              onClick={() => setActiveTab('temporary')}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center space-x-1.5 ${
                activeTab === 'temporary'
                  ? 'bg-amber-500 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Clock className="w-3.5 h-3.5" />
              <span>Temporary ({temporaryRules.length})</span>
            </button>
          </div>

          <button
            onClick={() => setShowAddModal(true)}
            className="p-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold flex items-center space-x-1 transition-all"
            title="Add Website"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Rules List */}
      <div className="mt-6 space-y-2.5">
        {activeTab === 'blocked' && (
          <>
            {blockedRules.length === 0 ? (
              <div className="text-center py-12 text-slate-400 text-sm">
                No blocked websites configured.
              </div>
            ) : (
              blockedRules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex items-center justify-between p-4 rounded-2xl bg-slate-50 hover:bg-red-50/40 border border-slate-100 transition-all group"
                >
                  <div className="flex items-center space-x-3.5">
                    <div className="w-9 h-9 rounded-xl bg-red-100 text-red-600 flex items-center justify-center font-bold text-xs">
                      <Globe className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="font-extrabold text-sm text-slate-900">{rule.domain}</span>
                        <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-md bg-red-100 text-red-700">
                          BLOCK
                        </span>
                      </div>
                      {rule.reason && (
                        <p className="text-xs text-slate-500 mt-0.5">{rule.reason}</p>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={() => onRemoveRule(rule.id)}
                    className="opacity-0 group-hover:opacity-100 p-2 text-slate-400 hover:text-red-600 rounded-xl hover:bg-red-100/50 transition-all"
                    title="Remove rule"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))
            )}
          </>
        )}

        {activeTab === 'allowed' && (
          <>
            {allowedRules.length === 0 ? (
              <div className="text-center py-12 text-slate-400 text-sm">
                No explicitly whitelisted websites.
              </div>
            ) : (
              allowedRules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex items-center justify-between p-4 rounded-2xl bg-slate-50 hover:bg-emerald-50/40 border border-slate-100 transition-all group"
                >
                  <div className="flex items-center space-x-3.5">
                    <div className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center font-bold text-xs">
                      <Globe className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="font-extrabold text-sm text-slate-900">{rule.domain}</span>
                        <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-700">
                          ALLOW
                        </span>
                      </div>
                      {rule.reason && (
                        <p className="text-xs text-slate-500 mt-0.5">{rule.reason}</p>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={() => onRemoveRule(rule.id)}
                    className="opacity-0 group-hover:opacity-100 p-2 text-slate-400 hover:text-red-600 rounded-xl hover:bg-red-100/50 transition-all"
                    title="Remove rule"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))
            )}
          </>
        )}

        {activeTab === 'temporary' && (
          <>
            {temporaryRules.length === 0 ? (
              <div className="text-center py-12 text-slate-400 text-sm">
                No active temporary access grants.
              </div>
            ) : (
              temporaryRules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex items-center justify-between p-4 rounded-2xl bg-amber-50/60 border border-amber-200/80 transition-all group"
                >
                  <div className="flex items-center space-x-3.5">
                    <div className="w-9 h-9 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center font-bold text-xs">
                      <Sparkles className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="font-extrabold text-sm text-slate-900">{rule.domain}</span>
                        <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-md bg-amber-200 text-amber-800 flex items-center gap-1">
                          <Clock className="w-2.5 h-2.5" />
                          {formatRemainingTime(rule.expiresAt!)}
                        </span>
                      </div>
                      <p className="text-xs text-amber-900/80 mt-0.5 font-medium">
                        {rule.reason || 'Temporary access granted'} • Reverts to BLOCK after expiry
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={() => onRemoveRule(rule.id)}
                    className="p-2 text-amber-700 hover:text-red-600 rounded-xl hover:bg-amber-100 transition-all"
                    title="Revoke access now"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))
            )}
          </>
        )}
      </div>

      {/* Add Website Rule Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 sm:p-7 shadow-2xl border border-slate-100">
            <h3 className="text-xl font-extrabold text-slate-900 tracking-tight mb-1">
              Add Website Rule
            </h3>
            <p className="text-xs text-slate-500 mb-5">
              Enforce a website rule across all of {childName}'s connected devices.
            </p>

            <form onSubmit={handleAddSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Website Domain or URL
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. youtube.com, reddit.com, wikipedia.org"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm font-medium"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Action
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setNewAction('BLOCK')}
                    className={`py-2.5 rounded-xl text-xs font-bold border transition-all ${
                      newAction === 'BLOCK'
                        ? 'bg-red-500 text-white border-red-500 shadow-sm'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    🚫 Block Website
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewAction('ALLOW')}
                    className={`py-2.5 rounded-xl text-xs font-bold border transition-all ${
                      newAction === 'ALLOW'
                        ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    ✅ Always Allow
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Optional Reason / Category
                </label>
                <input
                  type="text"
                  placeholder="e.g. Study tutorial, Distracting games"
                  value={newReason}
                  onChange={(e) => setNewReason(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm"
                />
              </div>

              <div className="flex items-center justify-end space-x-2 pt-3">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 rounded-xl text-sm font-bold bg-slate-900 hover:bg-slate-800 text-white shadow-md shadow-slate-900/20"
                >
                  Save Policy Rule
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
