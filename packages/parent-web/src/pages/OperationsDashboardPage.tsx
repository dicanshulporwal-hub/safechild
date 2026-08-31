import React, { useState, useEffect } from 'react';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import { RefreshCw } from 'lucide-react';

export const OperationsDashboardPage: React.FC = () => {
  const { showToast } = useToast();
  const [opsData, setOpsData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [rollingBack, setRollingBack] = useState(false);
  const [targetVersion, setTargetVersion] = useState('1.0.0');

  useEffect(() => {
    fetchOpsData();
  }, []);

  const fetchOpsData = async () => {
    setLoading(true);
    try {
      const data = await api.getOperationsFleet();
      setOpsData(data);
    } catch (e) {
      console.error('Error loading operations fleet:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleRollback = async () => {
    setRollingBack(true);
    try {
      const data = await api.dispatchRollback(
        targetVersion,
        'Emergency fleet rollback from parent admin console'
      );
      showToast(`Rollback dispatched to all ${data.affectedDevices} devices!`, 'success');
      fetchOpsData();
    } catch (e: any) {
      showToast(e.message || 'Rollback failed', 'error');
    } finally {
      setRollingBack(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-slate-400">Loading operations dashboard...</div>;
  }

  return (
    <div className="max-w-5xl space-y-6 animate-fadeIn">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-white tracking-tight">Beta Fleet & Operations Dashboard</h1>
          <p className="text-xs text-slate-400">Real-time telemetry, 4-state device health, and fleet emergency controls</p>
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
          <span className="text-[10px] uppercase font-bold text-slate-500">Active Devices</span>
          <div className="text-2xl font-extrabold text-white mt-1">{opsData?.totalDevices || 0}</div>
        </div>

        <div className="bg-slate-900 border border-emerald-500/30 p-4 rounded-2xl">
          <span className="text-[10px] uppercase font-bold text-emerald-400">Protected Fleet</span>
          <div className="text-2xl font-extrabold text-emerald-400 mt-1">{opsData?.protectedCount || 0}</div>
        </div>

        <div className="bg-slate-900 border border-amber-500/30 p-4 rounded-2xl">
          <span className="text-[10px] uppercase font-bold text-amber-400">Degraded Fleet</span>
          <div className="text-2xl font-extrabold text-amber-400 mt-1">{opsData?.degradedCount || 0}</div>
        </div>

        <div className="bg-slate-900 border border-indigo-500/30 p-4 rounded-2xl">
          <span className="text-[10px] uppercase font-bold text-indigo-400">Evaluation Latency</span>
          <div className="text-2xl font-extrabold text-indigo-300 mt-1 font-mono">0.03 ms</div>
        </div>
      </div>

      {/* Emergency Rollback Tool */}
      <div className="bg-slate-900 border border-rose-900/40 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="pb-3 border-b border-slate-800">
          <h2 className="text-sm font-bold text-rose-400 uppercase tracking-wider">Fleet Version Rollback (Safe Kill-Switch)</h2>
          <p className="text-xs text-slate-400">Dispatches an emergency downgrade command to all active Windows and Android agents</p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
          <input
            type="text"
            value={targetVersion}
            onChange={(e) => setTargetVersion(e.target.value)}
            placeholder="e.g. 1.0.0, 0.9.9"
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
    </div>
  );
};
