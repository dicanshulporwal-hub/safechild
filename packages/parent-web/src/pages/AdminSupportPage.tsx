import React, { useState, useEffect } from 'react';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import {
  MessageSquare,
  ShieldAlert,
  Inbox,
  CheckCircle2,
  Clock,
  RefreshCw,
  Search,
  Activity,
  Laptop,
} from 'lucide-react';

export const AdminSupportPage: React.FC = () => {
  const { showToast } = useToast();
  const [supportData, setSupportData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSupportData();
  }, []);

  const fetchSupportData = async () => {
    setLoading(true);
    try {
      const data = await api.getAdminSupport();
      setSupportData(data);
    } catch (e: any) {
      showToast(e.message || 'Failed to load support console', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-fadeIn pb-12">
      {/* Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-purple-600/20 text-purple-400 flex items-center justify-center font-bold">
              <MessageSquare className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-extrabold text-white tracking-tight">
                Support Diagnostics & Escalations
              </h1>
              <span className="text-[10px] font-bold text-purple-400 bg-purple-500/10 border border-purple-500/20 px-2 py-0.5 rounded-full uppercase">
                Operations Helpdesk
              </span>
            </div>
          </div>
          <p className="text-xs text-slate-400 mt-2">
            Consolidated platform view of pending user requests, high-frequency domain blocks, and support telemetry.
          </p>
        </div>

        <button
          onClick={fetchSupportData}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl transition flex items-center gap-1.5 shadow"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh</span>
        </button>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
          <div className="text-[10px] uppercase font-bold text-slate-500">Connected Fleet Devices</div>
          <div className="text-2xl font-black text-white mt-1">
            {supportData?.totalDevices || 0}
          </div>
        </div>

        <div className="bg-slate-900 border border-amber-500/30 p-4 rounded-2xl">
          <div className="text-[10px] uppercase font-bold text-amber-400">Open Ask-Parent Requests</div>
          <div className="text-2xl font-black text-amber-400 mt-1">
            {supportData?.pendingAccessRequests || 0}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
          <div className="text-[10px] uppercase font-bold text-slate-500">Recent Block Events Captured</div>
          <div className="text-2xl font-black text-indigo-400 mt-1">
            {supportData?.recentFilterEvents?.length || 0}
          </div>
        </div>
      </div>

      {/* Recent High-Priority Filter Events */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div>
            <h3 className="text-sm font-bold text-white uppercase tracking-wider">
              Recent Cross-Tenant Content Blocks & Alerts
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Live sample of domain enforcement events from active Android and Windows endpoints.
            </p>
          </div>
        </div>

        <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
          {loading ? (
            <div className="text-xs text-slate-500 text-center py-6">Loading events...</div>
          ) : !supportData?.recentFilterEvents || supportData.recentFilterEvents.length === 0 ? (
            <div className="text-xs text-slate-500 text-center py-6">No recent block events recorded.</div>
          ) : (
            supportData.recentFilterEvents.map((evt: any) => (
              <div
                key={evt.id}
                className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 flex items-center justify-between text-xs"
              >
                <div>
                  <div className="font-semibold text-white flex items-center gap-2">
                    <span className="font-mono text-rose-400">{evt.domain}</span>
                    <span className="text-[10px] bg-rose-500/10 text-rose-300 px-1.5 py-0.2 rounded font-bold">
                      {evt.action}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    Device: {evt.deviceName || evt.deviceId} • Reason: {evt.reason || 'Safety Policy Rule'}
                  </div>
                </div>
                <div className="text-[11px] text-slate-500 font-mono">
                  {new Date(evt.timestamp || Date.now()).toLocaleTimeString()}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
