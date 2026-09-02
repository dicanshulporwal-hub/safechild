import React, { useState, useEffect } from 'react';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import { RefreshCw, ShieldAlert, Terminal, Activity, RotateCcw } from 'lucide-react';

export const OperationsDashboardPage: React.FC = () => {
  const { showToast } = useToast();
  const [opsData, setOpsData] = useState<any>(null);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [targetVersion, setTargetVersion] = useState('1.1.0');
  const [bootstrapping, setBootstrapping] = useState(false);

  useEffect(() => {
    fetchOpsData();
  }, []);

  const fetchOpsData = async () => {
    setLoading(true);
    setForbidden(false);
    try {
      const [metrics, fleet, audit] = await Promise.all([
        api.getAdminMetrics().catch((e) => {
          if (e.message?.includes('Forbidden')) throw e;
          return null;
        }),
        api.getAdminFleet().catch((e) => {
          if (e.message?.includes('Forbidden')) throw e;
          return { devices: [] };
        }),
        api.getAdminAudit().catch((e) => {
          if (e.message?.includes('Forbidden')) throw e;
          return { logs: [] };
        }),
      ]);

      setOpsData({ ...metrics, ...fleet });
      if (audit?.logs) setAuditLogs(audit.logs);
    } catch (e: any) {
      if (e.message?.includes('Forbidden')) {
        setForbidden(true);
      }
      console.error('Error loading operations fleet:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleRollback = async () => {
    setRollingBack(true);
    try {
      const data = await api.dispatchAdminRollback(
        targetVersion,
        'Emergency fleet rollback from system administrator console'
      );
      showToast(`Rollback dispatched to all ${data.result?.affectedDevices || 'targeted'} devices!`, 'success');
      fetchOpsData();
    } catch (e: any) {
      showToast(e.message || 'Rollback failed', 'error');
    } finally {
      setRollingBack(false);
    }
  };

  const handleDevBootstrap = async () => {
    const secret = window.prompt('Enter DEV_ADMIN_BOOTSTRAP_SECRET to authenticate promotion:');
    if (!secret) return;
    setBootstrapping(true);
    try {
      const res = await api.bootstrapDevAdmin(secret);
      showToast(res.message || 'Promoted to SYSTEM_ADMIN!', 'success');
      fetchOpsData();
    } catch (e: any) {
      showToast(e.message || 'Dev bootstrap failed', 'error');
    } finally {
      setBootstrapping(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-slate-400">Loading operations dashboard...</div>;
  }

  if (forbidden) {
    return (
      <div className="max-w-2xl mx-auto my-12 p-8 bg-slate-900 border border-rose-900/50 rounded-2xl text-center space-y-4 shadow-2xl animate-fadeIn">
        <div className="w-12 h-12 rounded-2xl bg-rose-500/20 text-rose-400 flex items-center justify-center mx-auto">
          <ShieldAlert className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-bold text-white">403 — Forbidden: System Administrator Access Required</h2>
        <p className="text-xs text-slate-400 max-w-md mx-auto leading-relaxed">
          You are currently logged in as a normal family user. Only accounts with the explicit <span className="font-mono text-emerald-400">SYSTEM_ADMIN</span> role may access global fleet telemetry, support diagnostics, and rollback controls.
        </p>

        {process.env.NODE_ENV !== 'production' && (
          <div className="pt-4 border-t border-slate-800 space-y-2">
            <div className="text-[11px] text-amber-300 font-semibold flex items-center justify-center gap-1.5">
              <Terminal className="w-3.5 h-3.5" />
              <span>Development Mode Flag Active</span>
            </div>
            <button
              onClick={handleDevBootstrap}
              disabled={bootstrapping}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition shadow disabled:opacity-50"
            >
              {bootstrapping ? 'Promoting...' : 'Self-Promote to SYSTEM_ADMIN (Dev Only)'}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6 animate-fadeIn">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-extrabold text-white tracking-tight">System Admin Fleet & Operations</h1>
            <span className="text-[10px] font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30 px-2 py-0.5 rounded-full">
              SYSTEM_ADMIN
            </span>
          </div>
          <p className="text-xs text-slate-400">Cross-family telemetry, global device health, and emergency rollback kill-switches</p>
        </div>

        <button
          onClick={fetchOpsData}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl transition flex items-center gap-1.5"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh Telemetry</span>
        </button>
      </div>

      {/* Fleet Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
          <span className="text-[10px] uppercase font-bold text-slate-500">Total Families</span>
          <div className="text-2xl font-extrabold text-white mt-1">{opsData?.familiesCount || 0}</div>
        </div>

        <div className="bg-slate-900 border border-emerald-500/30 p-4 rounded-2xl">
          <span className="text-[10px] uppercase font-bold text-emerald-400">Protected Devices</span>
          <div className="text-2xl font-extrabold text-emerald-400 mt-1">{opsData?.healthBreakdown?.protected || 0}</div>
        </div>

        <div className="bg-slate-900 border border-amber-500/30 p-4 rounded-2xl">
          <span className="text-[10px] uppercase font-bold text-amber-400">Warning / Degraded</span>
          <div className="text-2xl font-extrabold text-amber-400 mt-1">{opsData?.healthBreakdown?.warning || 0}</div>
        </div>

        <div className="bg-slate-900 border border-indigo-500/30 p-4 rounded-2xl">
          <span className="text-[10px] uppercase font-bold text-indigo-400">Total Fleet</span>
          <div className="text-2xl font-extrabold text-indigo-300 mt-1 font-mono">{opsData?.devicesCount || 0}</div>
        </div>
      </div>

      {/* Emergency Rollback Tool */}
      <div className="bg-slate-900 border border-rose-900/40 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="pb-3 border-b border-slate-800">
          <h2 className="text-sm font-bold text-rose-400 uppercase tracking-wider flex items-center gap-2">
            <RotateCcw className="w-4 h-4" />
            <span>Fleet Emergency Rollback (Kill-Switch)</span>
          </h2>
          <p className="text-xs text-slate-400">Dispatches an immediate downgrade command across all active Windows and Android agents. Audited.</p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
          <input
            type="text"
            value={targetVersion}
            onChange={(e) => setTargetVersion(e.target.value)}
            placeholder="e.g. 1.0.0, 1.1.0"
            className="bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-xs font-mono w-44"
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

      {/* System Admin Audit Log Feed */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="pb-3 border-b border-slate-800">
          <h2 className="text-sm font-bold text-white uppercase tracking-wider">System Administrator Audit Trail</h2>
          <p className="text-xs text-slate-400">Append-only log of all privileged system actions and rollbacks</p>
        </div>

        <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
          {auditLogs.length === 0 ? (
            <div className="text-xs text-slate-500 text-center py-4">No privileged admin actions recorded yet.</div>
          ) : (
            auditLogs.map((l) => (
              <div key={l.id} className="p-3 rounded-xl bg-slate-950/50 border border-slate-800 flex items-center justify-between text-xs">
                <div>
                  <div className="font-semibold text-white flex items-center gap-2">
                    <span className="text-purple-400 font-mono text-[11px]">[{l.action}]</span>
                    <span>{l.details}</span>
                  </div>
                  <div className="text-[11px] text-slate-400">By {l.actorEmail} • {new Date(l.timestamp || Date.now()).toLocaleString()}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
