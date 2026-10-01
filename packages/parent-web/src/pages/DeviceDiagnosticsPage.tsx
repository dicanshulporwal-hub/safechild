import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useToast } from '../components/Toast';
import { api, Device } from '../api/client';
import {
  ShieldCheck,
  ArrowLeft,
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  AlertOctagon,
  Laptop,
  Radio,
  FileCheck,
  Lock,
  HelpCircle,
} from 'lucide-react';
import { DnsBenchmarkCard } from '../components/DnsBenchmarkCard';

interface DiagnosticCheck {
  name: string;
  pass: boolean | null;
  status?: 'passed' | 'warning' | 'failed' | 'unknown' | 'limited';
  detail: string;
}

export const DeviceDiagnosticsPage: React.FC = () => {
  const { deviceId } = useParams();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [device, setDevice] = useState<Device | null>(null);
  const [running, setRunning] = useState(false);
  const [checks, setChecks] = useState<DiagnosticCheck[]>([]);
  const [verdict, setVerdict] = useState<'PASS' | 'WARNING' | 'FAIL' | 'UNKNOWN'>('PASS');
  const [remediation, setRemediation] = useState<string>('');

  useEffect(() => {
    if (deviceId) {
      fetchDeviceAndRunDiagnostics(deviceId);
    }
  }, [deviceId]);

  const fetchDeviceAndRunDiagnostics = async (dId: string) => {
    setRunning(true);
    try {
      const [d, diag] = await Promise.all([
        api.getDeviceDetails(dId).catch(() => null),
        api.runDeviceDiagnostics(dId).catch((err) => {
          showToast(err.message || 'Failed to run diagnostics', 'error');
          return null;
        }),
      ]);

      if (d) {
        setDevice((d as any).device || d);
      }

      if (diag) {
        setChecks(diag.checks || []);
        setVerdict(diag.verdict || 'PASS');
        setRemediation(diag.remediation || '');
      }
    } catch (e: any) {
      console.error('Error in diagnostics:', e);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="max-w-4xl space-y-6 animate-fadeIn">
      {/* Back Link */}
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-white transition cursor-pointer"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Back to Child Workspace</span>
      </button>

      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-white tracking-tight">Protection Self-Diagnostics</h1>
          <p className="text-xs text-slate-400">
            Real-time security integrity verification for {device?.name || 'Device'} ({device?.platform ? device.platform.toUpperCase() : 'UNKNOWN'})
          </p>
        </div>

        <button
          onClick={() => deviceId && fetchDeviceAndRunDiagnostics(deviceId)}
          disabled={running}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition flex items-center gap-2 shadow disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} />
          <span>{running ? 'Diagnosing...' : 'Re-Run Diagnostics'}</span>
        </button>
      </div>

      {/* Overall Health Card */}
      <div className={`border rounded-2xl p-6 shadow-xl flex items-center justify-between ${
        verdict === 'PASS'
          ? 'bg-slate-900 border-emerald-500/30'
          : verdict === 'WARNING'
          ? 'bg-slate-900 border-amber-500/30'
          : verdict === 'UNKNOWN'
          ? 'bg-slate-900 border-slate-700'
          : 'bg-slate-900 border-rose-500/30'
      }`}>
        <div className="flex items-center gap-4">
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl font-bold ${
            verdict === 'PASS'
              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
              : verdict === 'WARNING'
              ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
              : verdict === 'UNKNOWN'
              ? 'bg-slate-800 text-slate-400 border border-slate-700'
              : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
          }`}>
            🛡️
          </div>
          <div>
            <div className="text-base font-bold text-white flex items-center gap-2">
              <span>Overall Protection Verdict:</span>
              <span className={`text-xs px-2.5 py-0.5 rounded-full font-mono font-bold border ${
                verdict === 'PASS'
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                  : verdict === 'WARNING'
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                  : verdict === 'UNKNOWN'
                  ? 'bg-slate-800 text-slate-300 border-slate-700'
                  : 'bg-rose-500/20 text-rose-300 border-rose-500/30'
              }`}>
                {verdict}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              {remediation || (running ? 'Executing automated verification checks...' : 'No diagnostic findings.')}
            </p>
          </div>
        </div>
      </div>

      {/* Device Runtime State Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl space-y-1.5">
          <div className="flex items-center justify-between text-slate-400 text-xs">
            <span className="flex items-center gap-1.5 font-medium">
              <Laptop className="w-4 h-4 text-emerald-400" /> Platform & OS
            </span>
          </div>
          <div className="text-xl font-extrabold text-white capitalize">{device?.platform || 'Unknown'}</div>
          <p className="text-[11px] text-slate-500 font-mono">
            {device?.mappedAccountName ? `Account: ${device.mappedAccountName}` : 'No account mapping'}
          </p>
        </div>

        <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl space-y-1.5">
          <div className="flex items-center justify-between text-slate-400 text-xs">
            <span className="flex items-center gap-1.5 font-medium">
              <Radio className="w-4 h-4 text-cyan-400" /> Policy Sync State
            </span>
          </div>
          <div className="text-xl font-extrabold text-white">{device?.policySyncStatus || 'UNKNOWN'}</div>
          <p className="text-[11px] text-slate-500">
            Active: v{device?.agentActivePolicyVersion ?? device?.activePolicyVersion ?? '?'}
          </p>
        </div>

        <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl space-y-1.5">
          <div className="flex items-center justify-between text-slate-400 text-xs">
            <span className="flex items-center gap-1.5 font-medium">
              <FileCheck className="w-4 h-4 text-indigo-400" /> Protection State
            </span>
          </div>
          <div className="text-sm font-bold text-white font-mono mt-1">
            {device?.protectionStatus || (device?.enforcementActive ? 'ACTIVE' : 'INACTIVE')}
          </div>
          <p className="text-[11px] text-slate-500">
            {device?.enforcementActive ? 'Enforcement engaged' : 'Enforcement stopped'}
          </p>
        </div>

        <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl space-y-1.5">
          <div className="flex items-center justify-between text-slate-400 text-xs">
            <span className="flex items-center gap-1.5 font-medium">
              <Lock className="w-4 h-4 text-amber-400" /> Agent Version
            </span>
          </div>
          <div className="text-xl font-extrabold text-white">
            {device?.agentVersion ? `v${device.agentVersion}` : 'Unknown'}
          </div>
          <p className="text-[11px] text-slate-500">
            {device?.lastHeartbeatAt ? `Last ping: ${new Date(device.lastHeartbeatAt).toLocaleTimeString()}` : 'No heartbeat yet'}
          </p>
        </div>
      </div>

      {/* Diagnostic Steps List */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-3">
        <h2 className="text-sm font-bold text-white uppercase tracking-wider mb-2">Automated Check Results</h2>

        {running ? (
          <div className="py-12 text-center text-xs font-bold text-slate-400">
            Running security checks...
          </div>
        ) : checks.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-500 italic">
            No diagnostic checks available. Click "Re-Run Diagnostics" to execute.
          </div>
        ) : (
          <div className="space-y-2.5">
            {checks.map((step, idx) => (
              <div key={idx} className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  {step.status === 'passed' ? (
                    <CheckCircle className="w-5 h-5 text-emerald-400 mt-0.5 shrink-0" />
                  ) : step.status === 'warning' || step.status === 'limited' ? (
                    <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
                  ) : step.status === 'unknown' ? (
                    <HelpCircle className="w-5 h-5 text-slate-500 mt-0.5 shrink-0" />
                  ) : (
                    <AlertOctagon className="w-5 h-5 text-rose-400 mt-0.5 shrink-0" />
                  )}
                  <div>
                    <div className="text-sm font-bold text-white flex items-center gap-2">
                      <span>{step.name}</span>
                      {step.status === 'warning' && (
                        <span className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded font-mono">
                          NOTICE
                        </span>
                      )}
                      {step.status === 'unknown' && (
                        <span className="text-[10px] bg-slate-800 text-slate-400 border border-slate-700 px-1.5 py-0.5 rounded font-mono">
                          UNMEASURED
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">{step.detail}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Real-time Resolver Speed & Latency Benchmark */}
      <DnsBenchmarkCard />
    </div>
  );
};
