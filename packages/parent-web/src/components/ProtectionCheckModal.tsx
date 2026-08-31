import React, { useEffect, useState } from 'react';
import { X, ShieldCheck, AlertTriangle, AlertOctagon, CheckCircle2, RefreshCw, Check, AlertCircle } from 'lucide-react';
import { Device } from '../api/client';

interface ProtectionCheckModalProps {
  device: Device;
  onClose: () => void;
}

export const ProtectionCheckModal: React.FC<ProtectionCheckModalProps> = ({ device, onClose }) => {
  const [report, setReport] = useState<any>(null);
  const [running, setRunning] = useState(true);

  const runCheck = () => {
    setRunning(true);
    fetch(`/api/devices/${device.id}/diagnostics`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${localStorage.getItem('sb_auth_token') || ''}`,
      },
    })
      .then((res) => res.json())
      .then((data) => {
        setReport(data);
        setRunning(false);
      })
      .catch(() => setRunning(false));
  };

  useEffect(() => {
    runCheck();
  }, [device.id]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn">
      <div className="bg-white rounded-3xl max-w-lg w-full p-6 sm:p-7 shadow-2xl border border-slate-200">
        <div className="flex items-center justify-between pb-4 border-b border-slate-100">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-2xl bg-emerald-100 text-emerald-800 flex items-center justify-center">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-base font-black text-slate-900">Run Protection Check</h3>
              <p className="text-xs text-slate-500 font-medium">Self-diagnostic audit for {device.name}</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {running ? (
          <div className="py-12 text-center space-y-3">
            <RefreshCw className="w-8 h-8 text-emerald-600 animate-spin mx-auto" />
            <div className="text-xs font-bold text-slate-700">Verifying device protection pipeline...</div>
            <p className="text-[11px] text-slate-400">Testing VPN filter, DNS proxy, and policy synchronization</p>
          </div>
        ) : report ? (
          <div className="mt-5 space-y-5">
            {/* Overall Verdict Banner */}
            <div
              className={`p-4 rounded-2xl border flex items-start space-x-3 ${
                report.verdict === 'PASS'
                  ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
                  : report.verdict === 'WARNING'
                  ? 'bg-amber-50/70 border-amber-200 text-amber-950'
                  : 'bg-red-50/70 border-red-200 text-red-950'
              }`}
            >
              {report.verdict === 'PASS' ? (
                <CheckCircle2 className="w-6 h-6 text-emerald-600 shrink-0 mt-0.5" />
              ) : report.verdict === 'WARNING' ? (
                <AlertTriangle className="w-6 h-6 text-amber-600 shrink-0 mt-0.5" />
              ) : (
                <AlertOctagon className="w-6 h-6 text-red-600 shrink-0 mt-0.5" />
              )}

              <div>
                <div className="text-sm font-black uppercase tracking-wide">
                  Protection Status: {report.verdict}
                </div>
                <p className="text-xs font-semibold opacity-90 mt-1">{report.remediation}</p>
              </div>
            </div>

            {/* Itemized 8 Checks */}
            <div>
              <h4 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-2.5">
                Diagnostic Pipeline Verification (8 Items)
              </h4>
              <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                {report.checks?.map((c: any, i: number) => (
                  <div
                    key={i}
                    className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/70 flex items-center justify-between text-xs"
                  >
                    <div className="flex items-center space-x-2">
                      {c.pass ? (
                        <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
                      )}
                      <span className="font-bold text-slate-800">{c.name}</span>
                    </div>
                    <span className="text-[11px] text-slate-500 font-medium">{c.detail}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-slate-100">
              <button
                onClick={runCheck}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center space-x-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Re-Test Now</span>
              </button>

              <button
                onClick={onClose}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="py-8 text-center text-xs text-red-500 font-bold">Failed to load diagnostics.</div>
        )}
      </div>
    </div>
  );
};
