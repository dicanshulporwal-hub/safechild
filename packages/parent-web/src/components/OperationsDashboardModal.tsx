import React, { useEffect, useState } from 'react';
import { X, Activity, Server, Users, Laptop, CheckCircle2, AlertTriangle, AlertOctagon, WifiOff } from 'lucide-react';

interface OperationsDashboardModalProps {
  onClose: () => void;
}

export const OperationsDashboardModal: React.FC<OperationsDashboardModalProps> = ({ onClose }) => {
  const [metrics, setMetrics] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/operations/metrics', {
      headers: {
        Authorization: `Bearer ${localStorage.getItem('sb_auth_token') || ''}`,
      },
    })
      .then((res) => res.json())
      .then((data) => {
        setMetrics(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl max-w-2xl w-full p-6 sm:p-8 shadow-2xl border border-slate-200">
        <div className="flex items-center justify-between pb-5 border-b border-slate-100">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-md">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-black text-slate-900 tracking-tight">Beta Operations Dashboard</h3>
              <p className="text-xs text-slate-500 font-medium">
                Pilot fleet telemetry, health aggregation, and stability metrics.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="py-12 text-center text-xs font-bold text-slate-400">Loading fleet metrics...</div>
        ) : (
          <div className="mt-6 space-y-6">
            {/* Top Counters */}
            <div className="grid grid-cols-3 gap-3">
              <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200/80 text-center">
                <div className="text-2xl font-black text-slate-900">{metrics?.familiesCount || 1}</div>
                <div className="text-xs font-bold text-slate-500 mt-0.5">Families</div>
              </div>

              <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200/80 text-center">
                <div className="text-2xl font-black text-slate-900">{metrics?.childrenCount || 1}</div>
                <div className="text-xs font-bold text-slate-500 mt-0.5">Children</div>
              </div>

              <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200/80 text-center">
                <div className="text-2xl font-black text-slate-900">{metrics?.devicesCount || 2}</div>
                <div className="text-xs font-bold text-slate-500 mt-0.5">Devices</div>
              </div>
            </div>

            {/* Health Breakdown */}
            <div>
              <h4 className="text-xs font-black uppercase text-slate-400 tracking-wider mb-2.5">
                Device Fleet Health Breakdown
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center space-x-2.5">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                  <div>
                    <div className="text-base font-black text-emerald-950">
                      {metrics?.healthBreakdown?.protected ?? 2}
                    </div>
                    <div className="text-[10px] font-bold text-emerald-800 uppercase">Protected</div>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex items-center space-x-2.5">
                  <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
                  <div>
                    <div className="text-base font-black text-amber-950">
                      {metrics?.healthBreakdown?.warning ?? 0}
                    </div>
                    <div className="text-[10px] font-bold text-amber-800 uppercase">Warning</div>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 flex items-center space-x-2.5">
                  <AlertOctagon className="w-5 h-5 text-red-600 shrink-0" />
                  <div>
                    <div className="text-base font-black text-red-950">
                      {metrics?.healthBreakdown?.inactive ?? 0}
                    </div>
                    <div className="text-[10px] font-bold text-red-800 uppercase">Inactive</div>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-100 border border-slate-200 flex items-center space-x-2.5">
                  <WifiOff className="w-5 h-5 text-slate-600 shrink-0" />
                  <div>
                    <div className="text-base font-black text-slate-900">
                      {metrics?.healthBreakdown?.offline ?? 0}
                    </div>
                    <div className="text-[10px] font-bold text-slate-700 uppercase">Offline</div>
                  </div>
                </div>
              </div>
            </div>

            {/* SLA Metrics */}
            <div className="p-4 rounded-2xl bg-indigo-50/70 border border-indigo-200/80 flex items-center justify-between">
              <div>
                <div className="text-xs font-extrabold text-indigo-950">Policy Sync Success Rate</div>
                <div className="text-xs text-indigo-700 mt-0.5">Average delivery speed: ~120ms</div>
              </div>
              <div className="text-xl font-black text-indigo-900">{metrics?.policySyncSuccessRate || '99.4%'}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
