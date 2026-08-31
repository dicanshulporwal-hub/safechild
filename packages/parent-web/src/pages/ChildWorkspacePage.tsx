import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useToast } from '../components/Toast';
import { api, Child, Policy, Device, ActivityEvent } from '../api/client';
import { TimelineEvent } from '@safebrowse/protocol';
import {
  ShieldCheck,
  Smartphone,
  Globe,
  Sliders,
  Moon,
  Activity,
  Plus,
  Trash2,
  Clock,
  Search,
} from 'lucide-react';
import { PolicySimulator } from '../components/PolicySimulator';
import { ProtectionTimeline } from '../components/ProtectionTimeline';
import { CategoryManager } from '../components/CategoryManager';
import { RoutinesCard } from '../components/RoutinesCard';
import { PairDeviceModal } from '../components/PairDeviceModal';

export const ChildWorkspacePage: React.FC<{ childrenList: Child[] }> = ({ childrenList }) => {
  const { childId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'overview';
  const { showToast } = useToast();

  const [child, setChild] = useState<Child | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const [budgets, setBudgets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Screen Time Composer
  const [budgetTarget, setBudgetTarget] = useState('');
  const [budgetTargetType, setBudgetTargetType] = useState<'DOMAIN' | 'CATEGORY' | 'APP'>('DOMAIN');
  const [budgetMinutes, setBudgetMinutes] = useState('60');

  // Pair modal
  const [showPairModal, setShowPairModal] = useState(false);

  // Inline Rule Composer
  const [ruleDomain, setRuleDomain] = useState('');
  const [ruleAction, setRuleAction] = useState<'BLOCK' | 'ALLOW'>('BLOCK');
  const [ruleReason, setRuleReason] = useState('');
  const [addingRule, setAddingRule] = useState(false);

  useEffect(() => {
    if (childId) {
      fetchChildData(childId);
    } else if (childrenList.length > 0) {
      navigate(`/children/${childrenList[0].id}`);
    }
  }, [childId, childrenList]);

  const fetchChildData = async (cId: string) => {
    setLoading(true);
    try {
      // Find matching child in childrenList or fetch fresh
      let currentChild = childrenList.find((k) => k.id === cId);
      if (!currentChild) {
        const freshKids = await api.getChildren();
        currentChild = freshKids.find((k) => k.id === cId) || freshKids[0];
      }
      setChild(currentChild || null);

      if (currentChild) {
        const [pol, devs, acts, tl, uBudgets] = await Promise.all([
          api.getPolicy(currentChild.id).catch(() => null),
          api.getDevices(currentChild.id).catch(() => []),
          api.getActivity(currentChild.id).catch(() => []),
          api.getTimeline(currentChild.id).catch(() => []),
          api.getUsageBudgets(currentChild.id).catch(() => []),
        ]);

        setPolicy(pol);
        setDevices(devs);
        setActivities(acts);
        setTimelineEvents(tl);
        setBudgets(uBudgets);
      }
    } catch (e: any) {
      console.error('Error loading child workspace:', e);
      showToast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleTogglePause = async () => {
    if (!child || !policy) return;
    const newPause = !policy.isPaused;
    try {
      const updated = await api.setPauseInternet(child.id, newPause);
      setPolicy(updated);
      showToast(newPause ? 'Internet paused for all devices.' : 'Internet protection resumed.', 'info');
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!child || !ruleDomain.trim()) return;
    setAddingRule(true);
    try {
      const updated = await api.addRule(child.id, ruleDomain.trim(), ruleAction, ruleReason.trim() || undefined);
      setPolicy(updated);
      setRuleDomain('');
      setRuleReason('');
      showToast(`Rule added: ${ruleDomain} (${ruleAction})`, 'success');
    } catch (e: any) {
      showToast(e.message, 'error');
    } finally {
      setAddingRule(false);
    }
  };

  const handleRemoveRule = async (ruleId: string) => {
    if (!child) return;
    try {
      const updated = await api.removeRule(child.id, ruleId);
      setPolicy(updated);
      showToast('Rule removed.', 'info');
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleRemoveDevice = async (deviceId: string) => {
    try {
      await api.removeDevice(deviceId);
      showToast('Device removed and revoked.', 'info');
      if (child) {
        const d = await api.getDevices(child.id);
        setDevices(d);
      }
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleUpdateCategory = async (catId: string, action: 'BLOCK' | 'ALLOW') => {
    if (!child || !policy) return;
    const currentControls = policy.categoryControls || [];
    const filtered = currentControls.filter((c) => c.category !== catId);
    const updatedControls = [...filtered, { category: catId, action }];
    try {
      const updated = await api.updateCategories(child.id, updatedControls as any);
      setPolicy(updated);
      showToast(`Category ${catId} updated to ${action}`, 'success');
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleToggleStudyMode = async (active: boolean) => {
    if (!child) return;
    try {
      const updated = await api.toggleStudyMode(child.id, active);
      setPolicy(updated);
      showToast(active ? 'Study Mode activated.' : 'Study Mode ended.', 'info');
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleToggleBedtime = async (enabled: boolean) => {
    if (!child) return;
    try {
      const updated = await api.toggleBedtime(child.id, {
        enabled,
        startHour: 21,
        startMinute: 30,
        endHour: 7,
        endMinute: 0,
        allowEducationalOnly: true,
      });
      setPolicy(updated);
      showToast(enabled ? 'Bedtime schedule enabled.' : 'Bedtime schedule disabled.', 'info');
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleAddBudget = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!child || !budgetTarget.trim()) return;
    try {
      await api.setUsageBudget(child.id, budgetTarget, budgetTargetType, Number(budgetMinutes));
      showToast(`Daily limit set for '${budgetTarget}'`, 'success');
      setBudgetTarget('');
      const fresh = await api.getUsageBudgets(child.id);
      setBudgets(fresh);
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleAddBonus = async (budgetId: string, minutes: number) => {
    if (!child) return;
    try {
      await api.addBonusTime(child.id, budgetId, minutes);
      showToast(`Added +${minutes} min bonus time`, 'success');
      const fresh = await api.getUsageBudgets(child.id);
      setBudgets(fresh);
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleSetUnlimited = async (budgetId: string) => {
    if (!child) return;
    try {
      await api.setUnlimitedToday(child.id, budgetId);
      showToast('Unlimited access granted for today', 'success');
      const fresh = await api.getUsageBudgets(child.id);
      setBudgets(fresh);
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleRemoveBudget = async (budgetId: string) => {
    if (!child) return;
    try {
      await api.removeUsageBudget(child.id, budgetId);
      showToast('Screen Time limit removed', 'info');
      const fresh = await api.getUsageBudgets(child.id);
      setBudgets(fresh);
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleToggleSafeSearch = async (key: string, value: any) => {
    if (!child || !policy) return;
    const current = policy.safeSearch || {
      googleSafeSearch: true,
      bingSafeSearch: true,
      duckDuckGoSafeSearch: true,
      youtubeRestrictedMode: 'OFF',
    };
    const updated = { ...current, [key]: value };
    try {
      const saved = await api.updateSafeSearch(child.id, updated);
      setPolicy(saved);
      showToast('SafeSearch configuration updated', 'success');
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  if (loading && !child) {
    return (
      <div className="p-12 text-center text-slate-400 space-y-3">
        <div className="w-8 h-8 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin mx-auto"></div>
        <div>Loading child workspace...</div>
      </div>
    );
  }

  if (!child) {
    return <div className="p-12 text-center text-slate-400">No child profile found.</div>;
  }

  const tabs = [
    { id: 'overview', label: 'Overview', icon: ShieldCheck },
    { id: 'devices', label: `Devices (${devices.length})`, icon: Smartphone },
    { id: 'protection', label: 'Web Protection', icon: Globe },
    { id: 'screentime', label: 'Screen Time', icon: Clock },
    { id: 'simulator', label: 'Policy Simulator', icon: Sliders },
    { id: 'routines', label: 'Routines', icon: Moon },
    { id: 'activity', label: 'Activity & Timeline', icon: Activity },
  ];

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Workspace Top Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-3xl shadow-inner">
            {child.avatar || '🧑'}
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-extrabold text-white tracking-tight">{child.name}</h1>
              {child.age && <span className="text-xs text-slate-400 font-semibold">{child.age} yrs</span>}
              <span className="text-xs bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2.5 py-0.5 rounded-full font-bold">
                🟢 PROTECTED
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              {devices.length} Paired Device{devices.length === 1 ? '' : 's'} • Policy v{policy?.version || 1}
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleTogglePause}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 ${
              policy?.isPaused
                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40 hover:bg-rose-500/30'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700'
            }`}
          >
            <span>{policy?.isPaused ? '⏸️ Paused' : '⏸️ Pause Net'}</span>
          </button>

          <button
            onClick={() => setShowPairModal(true)}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition shadow-md shadow-emerald-600/20 flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Pair Device</span>
          </button>
        </div>
      </div>

      {/* Tabs Navigation */}
      <div className="flex items-center gap-2 border-b border-slate-800 overflow-x-auto pb-px">
        {tabs.map((t) => {
          const isSelected = activeTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setSearchParams({ tab: t.id })}
              className={`flex items-center gap-2 px-4 py-2.5 border-b-2 text-xs font-bold whitespace-nowrap transition ${
                isSelected
                  ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5'
                  : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700'
              }`}
            >
              <t.icon className="w-4 h-4" />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB CONTENT AREAS */}

      {/* 1. OVERVIEW TAB */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 space-y-6">
            <RoutinesCard
              childName={child.name}
              policy={policy}
              onToggleStudyMode={handleToggleStudyMode}
              onToggleBedtime={handleToggleBedtime}
            />

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
              <h3 className="text-sm font-bold text-white uppercase tracking-wider">Recent Activity</h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {activities.length === 0 ? (
                  <div className="text-xs text-slate-500 py-3 text-center">No recent web activity recorded yet.</div>
                ) : (
                  activities.slice(0, 8).map((act) => (
                    <div key={act.id} className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 flex items-center justify-between text-xs">
                      <div>
                        <span className="font-bold text-white font-mono">{act.domain}</span>
                        <div className="text-[10px] text-slate-400">{new Date(act.timestamp).toLocaleTimeString()} • {act.reason || 'Web policy filter'}</div>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                        act.action === 'BLOCKED' ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-300'
                      }`}>
                        {act.action}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="lg:col-span-5 space-y-6">
            {/* Devices Card */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider">Connected Devices</h3>
                <span className="text-xs text-slate-400">{devices.length} Active</span>
              </div>

              <div className="space-y-2">
                {devices.length === 0 ? (
                  <div className="text-xs text-slate-500 py-3 text-center">No devices paired to this child yet.</div>
                ) : (
                  devices.map((dev) => (
                    <div
                      key={dev.id}
                      onClick={() => navigate(`/devices/${dev.id}/diagnostics`)}
                      className="p-3.5 bg-slate-950/70 hover:bg-slate-950 border border-slate-800 rounded-xl cursor-pointer transition flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">{dev.platform === 'android' ? '📱' : '💻'}</span>
                        <div>
                          <div className="text-xs font-bold text-white">{dev.name}</div>
                          <div className="text-[10px] text-slate-400 font-mono">v{dev.agentVersion || '1.0.0'} • {dev.platform}</div>
                        </div>
                      </div>
                      <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full font-bold">
                        {dev.healthStatus || 'PROTECTED'}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 2. DEVICES TAB */}
      {activeTab === 'devices' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-white">Managed Devices for {child.name}</h2>
              <p className="text-xs text-slate-400">All Android phones and Windows PCs bound to this child profile</p>
            </div>
            <button
              onClick={() => setShowPairModal(true)}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Pair New Device</span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {devices.length === 0 ? (
              <div className="col-span-2 p-8 bg-slate-900 border border-slate-800 rounded-2xl text-center text-xs text-slate-400">
                No devices paired yet. Click "Pair New Device" to generate a pairing code.
              </div>
            ) : (
              devices.map((dev) => (
                <div key={dev.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-2xl">
                        {dev.platform === 'android' ? '📱' : '💻'}
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-white">{dev.name}</h3>
                        <div className="text-xs text-slate-400">{dev.platform.toUpperCase()} • Agent {dev.agentVersion || '1.0.0'}</div>
                      </div>
                    </div>
                    <span className="text-[10px] px-2.5 py-1 rounded-full font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                      {dev.healthStatus || 'PROTECTED'}
                    </span>
                  </div>

                  <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-slate-500 text-[10px] uppercase">Enforcement</span>
                      <div className="font-semibold text-slate-300">{dev.platform === 'windows' ? 'WFP Kernel' : 'VpnService'}</div>
                    </div>
                    <div>
                      <span className="text-slate-500 text-[10px] uppercase">Heartbeat</span>
                      <div className="font-semibold text-slate-300">Live (WS Connected)</div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <button
                      onClick={() => navigate(`/devices/${dev.id}/diagnostics`)}
                      className="px-3.5 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/30 text-indigo-300 text-xs font-bold rounded-lg transition"
                    >
                      Run Diagnostics
                    </button>

                    <button
                      onClick={() => handleRemoveDevice(dev.id)}
                      className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition"
                      title="Revoke and Remove Device"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* 3. WEB PROTECTION TAB */}
      {activeTab === 'protection' && (
        <div className="space-y-6">
          {/* Inline Website Rule Composer */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">Inline Rule Composer</h2>
            <form onSubmit={handleAddRule} className="grid grid-cols-1 sm:grid-cols-12 gap-3">
              <div className="sm:col-span-5">
                <input
                  type="text"
                  required
                  placeholder="e.g. roblox.com, youtube.com"
                  value={ruleDomain}
                  onChange={(e) => setRuleDomain(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-white text-xs font-mono focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="sm:col-span-3">
                <select
                  value={ruleAction}
                  onChange={(e) => setRuleAction(e.target.value as any)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-white text-xs font-bold focus:outline-none focus:border-emerald-500"
                >
                  <option value="BLOCK">🚫 BLOCK</option>
                  <option value="ALLOW">🟢 ALLOW</option>
                </select>
              </div>

              <div className="sm:col-span-2">
                <input
                  type="text"
                  placeholder="Reason (Optional)"
                  value={ruleReason}
                  onChange={(e) => setRuleReason(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-white text-xs focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="sm:col-span-2">
                <button
                  type="submit"
                  disabled={addingRule || !ruleDomain.trim()}
                  className="w-full h-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition shadow disabled:opacity-50"
                >
                  {addingRule ? 'Adding...' : 'Add Rule'}
                </button>
              </div>
            </form>
          </div>

          {/* Active Rules List */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">Custom Website Rules</h2>
              <span className="text-xs text-slate-400">{policy?.rules?.length || 0} Rules</span>
            </div>

            <div className="space-y-2">
              {!policy?.rules || policy.rules.length === 0 ? (
                <div className="text-xs text-slate-500 py-3 text-center">No custom domain rules added yet.</div>
              ) : (
                policy.rules.map((r) => (
                  <div key={r.id} className="p-3.5 bg-slate-950/60 rounded-xl border border-slate-800 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        r.action === 'BLOCK' ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-300'
                      }`}>
                        {r.action}
                      </span>
                      <div>
                        <div className="text-sm font-bold text-white font-mono">{r.domain}</div>
                        {r.reason && <div className="text-xs text-slate-400">{r.reason}</div>}
                      </div>
                    </div>

                    <button
                      onClick={() => handleRemoveRule(r.id)}
                      className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* SafeSearch & YouTube Restricted Mode Controls */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="flex items-center gap-2 pb-3 border-b border-slate-800">
              <Search className="w-4 h-4 text-emerald-400" />
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">SafeSearch & Safer Content</h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-white">Google SafeSearch</div>
                  <div className="text-[10px] text-slate-400">Force strict search filtering</div>
                </div>
                <button
                  onClick={() => handleToggleSafeSearch('googleSafeSearch', !policy?.safeSearch?.googleSafeSearch)}
                  className={`w-11 h-6 flex items-center rounded-full p-1 transition duration-300 ${
                    policy?.safeSearch?.googleSafeSearch !== false ? 'bg-emerald-600 justify-end' : 'bg-slate-700 justify-start'
                  }`}
                >
                  <div className="bg-white w-4 h-4 rounded-full shadow-md transform"></div>
                </button>
              </div>

              <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-white">Bing SafeSearch</div>
                  <div className="text-[10px] text-slate-400">Enforce strict Bing filtering</div>
                </div>
                <button
                  onClick={() => handleToggleSafeSearch('bingSafeSearch', !policy?.safeSearch?.bingSafeSearch)}
                  className={`w-11 h-6 flex items-center rounded-full p-1 transition duration-300 ${
                    policy?.safeSearch?.bingSafeSearch !== false ? 'bg-emerald-600 justify-end' : 'bg-slate-700 justify-start'
                  }`}
                >
                  <div className="bg-white w-4 h-4 rounded-full shadow-md transform"></div>
                </button>
              </div>

              <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-white">DuckDuckGo Safe</div>
                  <div className="text-[10px] text-slate-400">Strict SafeSearch mode</div>
                </div>
                <button
                  onClick={() => handleToggleSafeSearch('duckDuckGoSafeSearch', !policy?.safeSearch?.duckDuckGoSafeSearch)}
                  className={`w-11 h-6 flex items-center rounded-full p-1 transition duration-300 ${
                    policy?.safeSearch?.duckDuckGoSafeSearch !== false ? 'bg-emerald-600 justify-end' : 'bg-slate-700 justify-start'
                  }`}
                >
                  <div className="bg-white w-4 h-4 rounded-full shadow-md transform"></div>
                </button>
              </div>
            </div>

            <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="text-xs font-bold text-white">YouTube Restricted Mode</div>
                <div className="text-[10px] text-slate-400">DNS-level restricted mode to filter mature videos and hide comments</div>
              </div>
              <select
                value={policy?.safeSearch?.youtubeRestrictedMode || 'OFF'}
                onChange={(e) => handleToggleSafeSearch('youtubeRestrictedMode', e.target.value)}
                className="bg-slate-900 border border-slate-700 text-xs font-bold text-white rounded-lg px-3 py-1.5 focus:outline-none focus:border-emerald-500"
              >
                <option value="OFF">OFF (Standard)</option>
                <option value="MODERATE">MODERATE (Filter Adult)</option>
                <option value="STRICT">STRICT (Maximum Filtering)</option>
              </select>
            </div>
          </div>

          {/* Category Controls */}
          <CategoryManager
            childName={child.name}
            policy={policy}
            onUpdateCategory={handleUpdateCategory}
          />
        </div>
      )}

      {/* 4. SCREEN TIME TAB */}
      {activeTab === 'screentime' && (
        <div className="space-y-6">
          {/* Add Daily Limit Form */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">Add Screen Time Quota</h2>
            <form onSubmit={handleAddBudget} className="grid grid-cols-1 sm:grid-cols-12 gap-3">
              <div className="sm:col-span-5">
                <input
                  type="text"
                  required
                  placeholder="Target (e.g. youtube.com, GAMING, com.zhiliaoapp.musically)"
                  value={budgetTarget}
                  onChange={(e) => setBudgetTarget(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-white text-xs font-mono focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="sm:col-span-3">
                <select
                  value={budgetTargetType}
                  onChange={(e) => setBudgetTargetType(e.target.value as any)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-white text-xs font-bold focus:outline-none focus:border-emerald-500"
                >
                  <option value="DOMAIN">🌐 Domain / Website</option>
                  <option value="CATEGORY">📁 Smart Category</option>
                  <option value="APP">📱 Android Native App</option>
                </select>
              </div>

              <div className="sm:col-span-2">
                <input
                  type="number"
                  min="1"
                  max="1440"
                  required
                  placeholder="Minutes/Day"
                  value={budgetMinutes}
                  onChange={(e) => setBudgetMinutes(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-white text-xs focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="sm:col-span-2">
                <button
                  type="submit"
                  disabled={!budgetTarget.trim()}
                  className="w-full h-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition shadow disabled:opacity-50"
                >
                  Set Daily Limit
                </button>
              </div>
            </form>
          </div>

          {/* Active Quotas and Live Progress */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div>
                <h2 className="text-sm font-bold text-white uppercase tracking-wider">Active Daily Limits & Usage</h2>
                <p className="text-xs text-slate-400">Usage is aggregated cross-device across all Android phones and Windows PCs</p>
              </div>
              <span className="text-xs text-slate-400">{budgets.length} Limits Active</span>
            </div>

            <div className="space-y-4">
              {budgets.length === 0 ? (
                <div className="text-xs text-slate-500 py-6 text-center">No screen-time limits configured for this child.</div>
              ) : (
                budgets.map((item) => {
                  const b = item.budget;
                  const consumedMin = Math.round(item.consumedSeconds / 60);
                  const limitMin = Math.round(b.dailyLimitSeconds / 60);
                  const bonusMin = Math.round((b.bonusSeconds || 0) / 60);
                  const totalMin = limitMin + bonusMin;
                  const percent = b.unlimitedToday ? 0 : Math.min(100, Math.round((consumedMin / totalMin) * 100));

                  return (
                    <div key={b.id} className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl space-y-3">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div className="flex items-center gap-3">
                          <span className="text-xl">
                            {b.targetType === 'APP' ? '📱' : b.targetType === 'CATEGORY' ? '📁' : '🌐'}
                          </span>
                          <div>
                            <div className="text-sm font-bold text-white font-mono flex items-center gap-2">
                              <span>{b.target}</span>
                              <span className="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded font-sans">
                                {b.targetType}
                              </span>
                            </div>
                            <div className="text-xs text-slate-400">
                              {b.unlimitedToday ? (
                                <span className="text-emerald-400 font-semibold">✨ Unlimited Access Today</span>
                              ) : (
                                <span>
                                  {consumedMin} / {totalMin} min used
                                  {bonusMin > 0 && ` (+${bonusMin}m bonus)`} •{' '}
                                  <span className={item.isLimitReached ? 'text-rose-400 font-bold' : 'text-slate-300'}>
                                    {item.isLimitReached ? 'LIMIT REACHED' : `${Math.round(item.remainingSeconds / 60)} min remaining`}
                                  </span>
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Quick Parent Grant Actions */}
                        <div className="flex items-center gap-1.5 self-end sm:self-auto">
                          <button
                            onClick={() => handleAddBonus(b.id, 15)}
                            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-lg transition"
                          >
                            +15m
                          </button>
                          <button
                            onClick={() => handleAddBonus(b.id, 30)}
                            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-lg transition"
                          >
                            +30m
                          </button>
                          <button
                            onClick={() => handleSetUnlimited(b.id)}
                            className="px-2.5 py-1 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 text-xs font-bold rounded-lg transition"
                          >
                            Unlimited
                          </button>
                          <button
                            onClick={() => handleRemoveBudget(b.id)}
                            className="p-1 text-slate-500 hover:text-rose-400 rounded-lg transition"
                            title="Delete Limit"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {/* Usage Progress Bar */}
                      {!b.unlimitedToday && (
                        <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-500 ${
                              percent >= 100 ? 'bg-rose-500' : percent >= 80 ? 'bg-amber-500' : 'bg-emerald-500'
                            }`}
                            style={{ width: `${percent}%` }}
                          ></div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* 5. POLICY SIMULATOR TAB */}
      {activeTab === 'simulator' && (
        <div className="space-y-6">
          <PolicySimulator childName={child.name} policy={policy} />
        </div>
      )}

      {/* 5. ROUTINES TAB */}
      {activeTab === 'routines' && (
        <div className="space-y-6">
          <RoutinesCard
            childName={child.name}
            policy={policy}
            onToggleStudyMode={handleToggleStudyMode}
            onToggleBedtime={handleToggleBedtime}
          />
        </div>
      )}

      {/* 6. ACTIVITY & TIMELINE TAB */}
      {activeTab === 'activity' && (
        <div className="space-y-6">
          <ProtectionTimeline childName={child.name} events={timelineEvents} />
        </div>
      )}

      {/* Pair Device Modal */}
      {showPairModal && (
        <PairDeviceModal
          childId={child.id}
          childName={child.name}
          onClose={() => setShowPairModal(false)}
          onDevicePaired={() => {
            setShowPairModal(false);
            fetchChildData(child.id);
          }}
        />
      )}
    </div>
  );
};
