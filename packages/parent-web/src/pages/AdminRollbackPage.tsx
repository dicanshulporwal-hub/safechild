import React, { useState, useEffect } from 'react';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import {
  RotateCcw,
  ShieldAlert,
  Server,
  Radio,
  CheckCircle2,
  AlertTriangle,
  History,
  Layers,
} from 'lucide-react';

export const AdminRollbackPage: React.FC = () => {
  const { showToast } = useToast();
  const [targetVersion, setTargetVersion] = useState('1.0.0');
  const [reason, setReason] = useState('');
  const [rollingBack, setRollingBack] = useState(false);
  const [recentRollbacks, setRecentRollbacks] = useState<any[]>([]);
  const [fleetMetrics, setFleetMetrics] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [metrics, audit] = await Promise.all([
        api.getAdminMetrics().catch(() => null),
        api.getAdminAudit().catch(() => ({ logs: [] })),
      ]);
      setFleetMetrics(metrics);
      if (audit?.logs) {
        const rollbacks = audit.logs.filter((l: any) =>
          l.action.includes('ROLLBACK')
        );
        setRecentRollbacks(rollbacks);
      }
    } catch (e: any) {
      console.error('Error loading rollback data:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleRollback = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetVersion.trim()) {
      showToast('Target version is required', 'error');
      return;
    }

    const confirm = window.confirm(
      `⚠️ EMERGENCY CONFIRMATION: Are you sure you want to broadcast a remote downgrade instruction to target version ${targetVersion} for all active device agents?`
    );
    if (!confirm) return;

    setRollingBack(true);
    try {
      const data = await api.dispatchAdminRollback(
        targetVersion.trim(),
        reason.trim() || 'Admin-dispatched fleet version rollback'
      );
      showToast(
        `Rollback dispatched to ${data.result?.affectedDevices || 'fleet'} devices!`,
        'success'
      );
      setReason('');
      loadData();
    } catch (err: any) {
      showToast(err.message || 'Rollback failed', 'error');
    } finally {
      setRollingBack(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6 animate-fadeIn pb-12">
      {/* Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-rose-600/20 text-rose-400 flex items-center justify-center font-bold">
              <RotateCcw className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-extrabold text-white tracking-tight">
                Remote Fleet Version Management & Rollback
              </h1>
              <span className="text-[10px] font-bold text-rose-400 bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 rounded-full uppercase">
                Critical Killswitch
              </span>
            </div>
          </div>
          <p className="text-xs text-slate-400 mt-2">
            Broadcast emergency policy version downgrades or rollback agent enforcement binaries across Windows and Android devices.
          </p>
        </div>
      </div>

      {/* Fleet Stats Overview */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
          <div className="text-[10px] uppercase font-bold text-slate-500">Active Devices</div>
          <div className="text-2xl font-black text-white mt-1">
            {fleetMetrics?.devicesCount || 0}
          </div>
        </div>

        <div className="bg-slate-900 border border-emerald-500/30 p-4 rounded-2xl">
          <div className="text-[10px] uppercase font-bold text-emerald-400">Policy Sync Rate</div>
          <div className="text-2xl font-black text-emerald-400 mt-1">
            {fleetMetrics?.policySyncSuccessRate || '99.4%'}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
          <div className="text-[10px] uppercase font-bold text-slate-500">Agent Crash Rate</div>
          <div className="text-2xl font-black text-indigo-400 mt-1">
            {fleetMetrics?.agentCrashRate || '0.1%'}
          </div>
        </div>
      </div>

      {/* Rollback Trigger Form */}
      <div className="bg-slate-900 border border-rose-900/30 rounded-2xl p-6 shadow-xl space-y-5">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white">Trigger Immediate Fleet Rollback</h2>
            <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
              When triggered, the backend marks the active policy version target and transmits WebSocket downgrade directives to all online agents. Offline agents apply the rollback upon their next heartbeat.
            </p>
          </div>
        </div>

        <form onSubmit={handleRollback} className="space-y-4 pt-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-300 uppercase mb-1.5">
                Target SafeBrowse Version
              </label>
              <div className="relative">
                <Layers className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  required
                  placeholder="e.g. 1.0.0"
                  value={targetVersion}
                  onChange={(e) => setTargetVersion(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-10 pr-4 py-2.5 text-xs text-white font-mono focus:outline-none focus:border-rose-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-300 uppercase mb-1.5">
                Rollback Reason & Operational Audit Note
              </label>
              <input
                type="text"
                placeholder="e.g. Investigating DNS latency regression in pilot build"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none focus:border-rose-500"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-3 border-t border-slate-800">
            <span className="text-[11px] text-slate-500">
              Action is strictly audited under <span className="font-mono text-purple-400">SYSTEM_ROLLBACK_EXECUTE</span>.
            </span>
            <button
              type="submit"
              disabled={rollingBack}
              className="px-6 py-2.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-rose-600/20 transition disabled:opacity-50 cursor-pointer flex items-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              <span>{rollingBack ? 'Dispatching...' : 'Dispatch Emergency Rollback'}</span>
            </button>
          </div>
        </form>
      </div>

      {/* Rollback Audit Trail */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-purple-400" />
            <h3 className="text-sm font-bold text-white uppercase tracking-wider">
              Rollback Audit Log History
            </h3>
          </div>
          <span className="text-[10px] text-slate-500 font-mono">
            {recentRollbacks.length} Events Logged
          </span>
        </div>

        {recentRollbacks.length === 0 ? (
          <div className="text-xs text-slate-500 text-center py-6">
            No emergency rollbacks recorded in system audit logs.
          </div>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {recentRollbacks.map((log) => (
              <div
                key={log.id}
                className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 flex items-center justify-between text-xs"
              >
                <div>
                  <div className="font-semibold text-rose-300 flex items-center gap-2">
                    <span className="font-mono text-[11px] bg-rose-500/10 px-1.5 py-0.5 rounded text-rose-400">
                      [{log.action}]
                    </span>
                    <span>{log.details}</span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1">
                    Actor: {log.actorEmail || log.actorUserId} • {new Date(log.timestamp || Date.now()).toLocaleString()} • IP: {log.ipAddress || '127.0.0.1'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
