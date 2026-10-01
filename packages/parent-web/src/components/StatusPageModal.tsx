import React, { useEffect, useState } from 'react';
import { X, Activity, CheckCircle2, HelpCircle, AlertOctagon } from 'lucide-react';

interface StatusPageModalProps {
  onClose: () => void;
}

export const StatusPageModal: React.FC<StatusPageModalProps> = ({ onClose }) => {
  const [statusData, setStatusData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch('/api/operations/status')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch status');
        return res.json();
      })
      .then((data) => {
        setStatusData(data);
        setLoading(false);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
  }, []);

  const isOperational = statusData?.status === 'OPERATIONAL';
  const isDegraded = statusData?.status === 'DEGRADED';
  const services = statusData?.services || [];

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn">
      <div className="bg-white rounded-3xl max-w-lg w-full p-6 sm:p-7 shadow-2xl border border-slate-200">
        <div className="flex items-center justify-between pb-4 border-b border-slate-100">
          <div className="flex items-center space-x-3">
            <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shadow-md ${
              isOperational ? 'bg-emerald-600 text-white' : isDegraded ? 'bg-rose-600 text-white' : 'bg-slate-700 text-white'
            }`}>
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-black text-slate-900">SafeBrowse System Status</h3>
              <p className="text-xs text-slate-500 font-medium">Live public operational health & uptime</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition-all cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="py-12 text-center text-xs font-bold text-slate-400">Loading system status...</div>
        ) : error ? (
          <div className="mt-5 p-6 rounded-2xl bg-slate-50 border border-slate-200 text-center space-y-2">
            <AlertOctagon className="w-8 h-8 text-slate-400 mx-auto" />
            <div className="text-sm font-bold text-slate-700">Status Unavailable</div>
            <p className="text-xs text-slate-500">Failed to connect to the monitoring endpoint.</p>
          </div>
        ) : (
          <div className="mt-5 space-y-4">
            {/* Main Status Header */}
            <div className={`p-4 rounded-2xl border flex items-center justify-between ${
              isOperational
                ? 'bg-emerald-50 border-emerald-200'
                : isDegraded
                ? 'bg-rose-50 border-rose-200'
                : 'bg-slate-50 border-slate-200'
            }`}>
              <div className="flex items-center space-x-2.5">
                {isOperational ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                ) : isDegraded ? (
                  <AlertOctagon className="w-5 h-5 text-rose-600 shrink-0" />
                ) : (
                  <HelpCircle className="w-5 h-5 text-slate-500 shrink-0" />
                )}
                <span className={`text-xs font-black uppercase ${
                  isOperational ? 'text-emerald-950' : isDegraded ? 'text-rose-950' : 'text-slate-800'
                }`}>
                  {isOperational
                    ? 'All Systems Operational'
                    : isDegraded
                    ? 'Degraded Performance'
                    : 'Status Unmonitored / Unknown'}
                </span>
              </div>
              <span className="text-xs font-black text-slate-700 bg-white/80 px-2.5 py-0.5 rounded-lg border border-slate-200">
                Uptime: {statusData?.uptimeAvailable && statusData?.uptime ? statusData.uptime : 'Not Available'}
              </span>
            </div>

            {/* Sub-Services List */}
            {services.length === 0 ? (
              <div className="py-4 text-center text-xs text-slate-400 italic">No service telemetry reported.</div>
            ) : (
              <div className="space-y-2">
                {services.map((svc: any, idx: number) => {
                  const isSvcOp = svc.status === 'OPERATIONAL' || svc.status === 'Operational';
                  const isSvcUnknown = svc.status === 'UNKNOWN' || !svc.status;
                  return (
                    <div
                      key={idx}
                      className="p-3 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center space-x-2">
                        <span className={`w-2 h-2 rounded-full ${
                          isSvcOp ? 'bg-emerald-500' : isSvcUnknown ? 'bg-slate-400' : 'bg-rose-500'
                        }`}></span>
                        <span className="font-bold text-slate-800">{svc.name}</span>
                      </div>
                      <span className={`text-[11px] font-black px-2 py-0.5 rounded-md ${
                        isSvcOp
                          ? 'text-emerald-700 bg-emerald-100/80'
                          : isSvcUnknown
                          ? 'text-slate-600 bg-slate-200'
                          : 'text-rose-700 bg-rose-100/80'
                      }`}>
                        {svc.status}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

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
