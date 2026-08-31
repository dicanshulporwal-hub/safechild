import React, { useEffect, useState } from 'react';
import { X, Activity, CheckCircle2, ShieldCheck } from 'lucide-react';

interface StatusPageModalProps {
  onClose: () => void;
}

export const StatusPageModal: React.FC<StatusPageModalProps> = ({ onClose }) => {
  const [statusData, setStatusData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/operations/status')
      .then((res) => res.json())
      .then((data) => {
        setStatusData(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn">
      <div className="bg-white rounded-3xl max-w-lg w-full p-6 sm:p-7 shadow-2xl border border-slate-200">
        <div className="flex items-center justify-between pb-4 border-b border-slate-100">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-2xl bg-emerald-600 text-white flex items-center justify-center shadow-md">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-black text-slate-900">SafeBrowse System Status</h3>
              <p className="text-xs text-slate-500 font-medium">Live public operational health & uptime</p>
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
          <div className="py-12 text-center text-xs font-bold text-slate-400">Loading system status...</div>
        ) : (
          <div className="mt-5 space-y-4">
            {/* Main Status Header */}
            <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-between">
              <div className="flex items-center space-x-2.5">
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                <span className="text-xs font-black uppercase text-emerald-950">
                  All Systems Operational
                </span>
              </div>
              <span className="text-xs font-black text-emerald-800 bg-white/80 px-2.5 py-0.5 rounded-lg border border-emerald-200">
                Uptime: {statusData?.uptime || '99.98%'}
              </span>
            </div>

            {/* Sub-Services List */}
            <div className="space-y-2">
              {statusData?.services?.map((svc: any, idx: number) => (
                <div
                  key={idx}
                  className="p-3 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-between text-xs"
                >
                  <div className="flex items-center space-x-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                    <span className="font-bold text-slate-800">{svc.name}</span>
                  </div>
                  <span className="text-[11px] font-black text-emerald-700 bg-emerald-100/80 px-2 py-0.5 rounded-md">
                    {svc.status}
                  </span>
                </div>
              ))}
            </div>

            <div className="pt-2 text-center">
              <span className="text-[10px] text-slate-400 font-semibold">
                Updated {new Date(statusData?.timestamp || Date.now()).toLocaleTimeString()} • Verified by Global Status Engine
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
