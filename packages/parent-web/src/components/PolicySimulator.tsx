import React, { useState } from 'react';
import { api, Policy } from '../api/client';
import { evaluatePolicyDetailed, DetailedPolicyDecision } from '@safebrowse/shared';
import { Play, Sparkles, CheckCircle2, XCircle, Clock, ShieldAlert, Sliders } from 'lucide-react';

interface PolicySimulatorProps {
  childName: string;
  policy: Policy | null;
}

export const PolicySimulator: React.FC<PolicySimulatorProps> = ({ childName, policy }) => {
  const [testDomain, setTestDomain] = useState('youtube.com');
  const [simTime, setSimTime] = useState<string>('');
  const [result, setResult] = useState<DetailedPolicyDecision | null>(null);

  const handleSimulate = () => {
    if (!policy || !testDomain.trim()) return;

    let evalDate = new Date();
    if (simTime) {
      const [hours, minutes] = simTime.split(':');
      evalDate.setHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);
    }

    const decision = evaluatePolicyDetailed(policy as any, testDomain.trim(), evalDate);
    setResult(decision);
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800/90 rounded-3xl p-6 sm:p-8 shadow-2xl backdrop-blur-xl space-y-6">
      <div className="flex items-center justify-between pb-5 border-b border-slate-800/80">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-indigo-500/20 to-purple-500/20 border border-indigo-500/30 text-indigo-400 flex items-center justify-center shadow-inner">
            <Sliders className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-extrabold text-white tracking-tight">Real-Engine Policy Simulator</h3>
              <span className="bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-[10px] font-extrabold uppercase px-2.5 py-0.5 rounded-full">
                Kernel Parity
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Test any website, subcategory, or time against {childName}'s active policy rules.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <label className="text-xs font-bold text-slate-300 block mb-1.5">Website Domain or URL</label>
            <input
              type="text"
              value={testDomain}
              onChange={(e) => setTestDomain(e.target.value)}
              placeholder="e.g. youtube.com, roblox.com, wikipedia.org"
              className="w-full px-4 py-2.5 rounded-xl bg-slate-950 border border-slate-700/80 text-white font-mono text-xs focus:outline-none focus:border-emerald-500 transition shadow-inner"
            />
          </div>

          <div>
            <label className="text-xs font-bold text-slate-300 block mb-1.5">Simulated Time (Optional)</label>
            <input
              type="time"
              value={simTime}
              onChange={(e) => setSimTime(e.target.value)}
              className="w-full px-4 py-2.5 rounded-xl bg-slate-950 border border-slate-700/80 text-white font-mono text-xs focus:outline-none focus:border-emerald-500 transition shadow-inner"
            />
          </div>
        </div>

        <button
          onClick={handleSimulate}
          className="w-full py-3 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-xs flex items-center justify-center gap-2 transition-all shadow-lg shadow-emerald-500/20 cursor-pointer"
        >
          <Play className="w-4 h-4 fill-slate-950" />
          <span>Execute Simulation Evaluation</span>
        </button>

        {/* Simulator Results Breakdown */}
        {result && (
          <div className="mt-5 pt-5 border-t border-slate-800/80 space-y-4 animate-fadeIn">
            <div
              className={`p-4 rounded-2xl border flex items-center justify-between ${
                result.action === 'BLOCK'
                  ? 'bg-rose-950/30 border-rose-500/40 text-rose-200'
                  : 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
              }`}
            >
              <div className="flex items-center gap-3">
                {result.action === 'BLOCK' ? (
                  <XCircle className="w-7 h-7 text-rose-400 shrink-0" />
                ) : (
                  <CheckCircle2 className="w-7 h-7 text-emerald-400 shrink-0" />
                )}
                <div>
                  <div className="text-sm font-extrabold">
                    Final Decision: {result.action === 'BLOCK' ? '🚫 BLOCKED' : '🟢 ALLOWED'}
                  </div>
                  <div className="text-xs opacity-90 mt-0.5">
                    <strong>Rule Source:</strong> {result.matchedRuleType} • {result.reason}
                  </div>
                </div>
              </div>

              <span className="text-[11px] font-extrabold uppercase px-2.5 py-1 rounded-xl bg-slate-950/80 border border-slate-700 text-slate-300">
                Policy v{result.policyVersion || policy?.version}
              </span>
            </div>

            {/* Step-by-Step Evaluation Trace */}
            <div>
              <h4 className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400 mb-2.5">
                Evaluation Pipeline Trace
              </h4>
              <div className="space-y-2">
                {result.evaluationTrace.map((step, idx) => (
                  <div
                    key={idx}
                    className={`px-4 py-2.5 rounded-xl text-xs flex items-center justify-between border ${
                      step.matched
                        ? step.resultAction === 'BLOCK'
                          ? 'bg-rose-950/30 border-rose-500/40 font-bold text-rose-300'
                          : 'bg-emerald-950/30 border-emerald-500/40 font-bold text-emerald-300'
                        : 'bg-slate-950/60 border-slate-800/80 text-slate-400 font-medium'
                    }`}
                  >
                    <span>{step.level}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono">{step.detail}</span>
                      {step.matched && (
                        <span className="font-extrabold uppercase text-[10px] px-2 py-0.5 rounded bg-slate-900 border border-slate-700">
                          [{step.resultAction}]
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
