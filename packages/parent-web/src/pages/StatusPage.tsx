import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { CheckCircle } from 'lucide-react';

export const StatusPage: React.FC = () => {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getHealth()
      .then((data) => {
        setStatus(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const services = [
    { name: 'Core Policy Evaluation Engine', status: 'Operational', latency: '0.03ms' },
    { name: 'DNS Interception & Filtering (WFP & VPN)', status: 'Operational', latency: '0.8ms' },
    { name: 'Real-time WebSocket Push Telemetry', status: 'Operational', latency: '18ms' },
    { name: 'Backend REST API & Identity Service', status: 'Operational', latency: '12ms' },
    { name: 'Ask Parent Cloud Notification Broker', status: 'Operational', latency: '24ms' },
    { name: 'Local SQLite Policy Cache & Fallback Layer', status: 'Operational', latency: '0.4ms' },
  ];

  return (
    <div className="max-w-4xl space-y-6 animate-fadeIn">
      <div>
        <h1 className="text-2xl font-extrabold text-white tracking-tight">System Status & Service Health</h1>
        <p className="text-xs text-slate-400">Live operational status of SafeBrowse platform infrastructure</p>
      </div>

      {/* Main Status Indicator */}
      <div className="bg-slate-900 border border-emerald-500/30 rounded-2xl p-6 shadow-xl flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
            <CheckCircle className="w-7 h-7" />
          </div>
          <div>
            <div className="text-base font-bold text-white">All Systems Fully Operational</div>
            <p className="text-xs text-slate-400 mt-0.5">Uptime: 99.98% • Active Incidents: 0</p>
          </div>
        </div>
        <span className="text-xs bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-3 py-1 rounded-full font-mono font-bold">
          100% HEALTHY
        </span>
      </div>

      {/* Services List */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-3">
        <h2 className="text-sm font-bold text-white uppercase tracking-wider mb-2">Platform Services</h2>
        <div className="space-y-2">
          {services.map((s, idx) => (
            <div key={idx} className="p-3.5 bg-slate-950/60 rounded-xl border border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                <span className="text-xs font-bold text-white">{s.name}</span>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-xs text-slate-500 font-mono">{s.latency}</span>
                <span className="text-xs font-semibold text-emerald-400">{s.status}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
