import React, { useState, useEffect } from 'react';
import { CheckCircle, HelpCircle, AlertOctagon } from 'lucide-react';

export const StatusPage: React.FC = () => {
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
    <div className="max-w-4xl space-y-6 animate-fadeIn">
      <div>
        <h1 className="text-2xl font-extrabold text-white tracking-tight">System Status & Service Health</h1>
        <p className="text-xs text-slate-400">Live operational status of SafeBrowse platform infrastructure</p>
      </div>

      {/* Main Status Indicator */}
      <div className={`bg-slate-900 border rounded-2xl p-6 shadow-xl flex items-center justify-between ${
        isOperational
          ? 'border-emerald-500/30'
          : isDegraded
          ? 'border-rose-500/30'
          : 'border-slate-800'
      }`}>
        <div className="flex items-center gap-4">
          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${
            isOperational
              ? 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-400'
              : isDegraded
              ? 'bg-rose-500/20 border border-rose-500/30 text-rose-400'
              : 'bg-slate-800 border border-slate-700 text-slate-400'
          }`}>
            {isOperational ? (
              <CheckCircle className="w-7 h-7" />
            ) : isDegraded ? (
              <AlertOctagon className="w-7 h-7" />
            ) : (
              <HelpCircle className="w-7 h-7" />
            )}
          </div>
          <div>
            <div className="text-base font-bold text-white">
              {error
                ? 'Status Unavailable'
                : isOperational
                ? 'All Systems Operational'
                : isDegraded
                ? 'Degraded Performance'
                : 'Status Unmonitored / Unknown'}
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Uptime: {statusData?.uptimeAvailable && statusData?.uptime ? statusData.uptime : 'Not Available'} • Active Incidents: {statusData?.activeIncidentsAvailable && statusData?.activeIncidents != null ? statusData.activeIncidents : 'Not Available'}
            </p>
          </div>
        </div>
        <span className={`text-xs px-3 py-1 rounded-full font-mono font-bold border ${
          isOperational
            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
            : isDegraded
            ? 'bg-rose-500/20 text-rose-300 border-rose-500/30'
            : 'bg-slate-800 text-slate-400 border-slate-700'
        }`}>
          {error ? 'UNAVAILABLE' : (statusData?.status || 'UNKNOWN')}
        </span>
      </div>

      {/* Services List */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-3">
        <h2 className="text-sm font-bold text-white uppercase tracking-wider mb-2">Platform Services</h2>
        {loading ? (
          <div className="py-8 text-center text-xs text-slate-400">Loading service health telemetry...</div>
        ) : error || services.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-500 italic">
            Status data unavailable from monitoring endpoint.
          </div>
        ) : (
          <div className="space-y-2">
            {services.map((s: any, idx: number) => {
              const isSvcOp = s.status === 'OPERATIONAL' || s.status === 'Operational';
              const isSvcUnknown = s.status === 'UNKNOWN' || !s.status;
              return (
                <div key={idx} className="p-3.5 bg-slate-950/60 rounded-xl border border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full ${
                      isSvcOp ? 'bg-emerald-400' : isSvcUnknown ? 'bg-slate-500' : 'bg-rose-400'
                    }`}></span>
                    <span className="text-xs font-bold text-white">{s.name}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className={`text-xs font-semibold ${
                      isSvcOp ? 'text-emerald-400' : isSvcUnknown ? 'text-slate-400' : 'text-rose-400'
                    }`}>
                      {s.status}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
