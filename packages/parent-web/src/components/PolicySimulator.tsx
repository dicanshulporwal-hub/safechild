import React, { useState } from 'react';
import { api, Policy } from '../api/client';
import { evaluatePolicyDetailed, DetailedPolicyDecision } from '@safebrowse/shared';
import { Play, Sparkles, CheckCircle2, XCircle, Clock, ShieldAlert } from 'lucide-react';

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
    <div className="bg-white rounded-3xl p-6 sm:p-7 shadow-sm border border-slate-200/80">
      <div className="flex items-center justify-between pb-5 border-b border-slate-100">
        <div>
          <div className="flex items-center space-x-2">
            <h3 className="text-xl font-black text-slate-900 tracking-tight">Policy Simulator</h3>
            <span className="bg-indigo-100 text-indigo-800 text-[10px] font-black uppercase px-2 py-0.5 rounded-full">
              Real-Engine Parity
            </span>
          </div>
          <p className="text-xs text-slate-500 font-medium mt-0.5">
            Test any website and time against {childName}'s exact active policy rules.
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <label className="text-xs font-bold text-slate-700 block mb-1">Website Domain or URL</label>
            <input
              type="text"
              value={testDomain}
              onChange={(e) => setTestDomain(e.target.value)}
              placeholder="e.g. youtube.com, roblox.com, wikipedia.org"
              className="w-full px-4 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div>
            <label className="text-xs font-bold text-slate-700 block mb-1">Simulated Time (Optional)</label>
            <input
              type="time"
              value={simTime}
              onChange={(e) => setSimTime(e.target.value)}
              className="w-full px-4 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
        </div>

        <button
          onClick={handleSimulate}
          className="w-full py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-extrabold text-xs flex items-center justify-center space-x-2 transition-all shadow-md"
        >
          <Play className="w-4 h-4 fill-white" />
          <span>Run Policy Evaluation</span>
        </button>

        {/* Simulator Results Breakdown */}
        {result && (
          <div className="mt-5 pt-5 border-t border-slate-100 space-y-4">
            <div
              className={`p-4 rounded-2xl border flex items-center justify-between ${
                result.action === 'BLOCK'
                  ? 'bg-red-50/70 border-red-200 text-red-950'
                  : 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
              }`}
            >
              <div className="flex items-center space-x-3">
                {result.action === 'BLOCK' ? (
                  <XCircle className="w-7 h-7 text-red-600 shrink-0" />
                ) : (
                  <CheckCircle2 className="w-7 h-7 text-emerald-600 shrink-0" />
                )}
                <div>
                  <div className="text-base font-black">
                    Final Decision: {result.action === 'BLOCK' ? '🚫 BLOCKED' : '✅ ALLOWED'}
                  </div>
                  <div className="text-xs font-semibold opacity-90 mt-0.5">
                    <strong>Rule Source:</strong> {result.matchedRuleType} • {result.reason}
                  </div>
                </div>
              </div>

              <span className="text-[11px] font-black uppercase px-2.5 py-1 rounded-lg bg-white/80 shadow-sm border border-slate-200/50">
                Policy v{result.policyVersion || policy?.version}
              </span>
            </div>

            {/* Step-by-Step Evaluation Trace */}
            <div>
              <h4 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-2">
                Evaluation Pipeline Trace
              </h4>
              <div className="space-y-1.5">
                {result.evaluationTrace.map((step, idx) => (
                  <div
                    key={idx}
                    className={`px-3.5 py-2 rounded-xl text-xs flex items-center justify-between border ${
                      step.matched
                        ? step.resultAction === 'BLOCK'
                          ? 'bg-red-50 border-red-200 font-bold text-red-800'
                          : 'bg-emerald-50 border-emerald-200 font-bold text-emerald-800'
                        : 'bg-slate-50/60 border-slate-100 text-slate-500 font-medium'
                    }`}
                  >
                    <span>{step.level}</span>
                    <div className="flex items-center space-x-2">
                      <span className="text-[11px]">{step.detail}</span>
                      {step.matched && (
                        <span className="font-extrabold uppercase text-[10px]">
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
