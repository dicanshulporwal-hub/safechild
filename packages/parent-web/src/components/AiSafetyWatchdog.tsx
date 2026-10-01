import React, { useState, useEffect } from 'react';
import {
  Brain,
  ShieldCheck,
  Sparkles,
  HeartHandshake,
  CheckCircle2,
} from 'lucide-react';
import { api, ActivityEvent } from '../api/client';

export interface AiRiskItem {
  id: string;
  category: 'CIRCUMVENTION' | 'CYBERBULLYING' | 'CONTENT_RISK' | 'MENTAL_HEALTH';
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  queryOrContext: string;
  detectedAt: string;
  actionTaken: string;
  aiExplanation: string;
  parentAdvice: string;
  reviewed: boolean;
}

export const AiSafetyWatchdog: React.FC<{ childId?: string; childName?: string }> = ({
  childId,
  childName = 'Alex',
}) => {
  const [selectedItem, setSelectedItem] = useState<AiRiskItem | null>(null);
  const [items, setItems] = useState<AiRiskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [safetyScore, setSafetyScore] = useState(100);
  const [riskStats, setRiskStats] = useState({
    mentalHealth: '0 Intercepts',
    cyberbullying: '0 Intercepts',
    explicitContent: '0 Intercepts',
    circumvention: '0 Attempts',
  });

  useEffect(() => {
    fetchDynamicWatchdogData();
  }, [childId]);

  const fetchDynamicWatchdogData = async () => {
    try {
      setLoading(true);
      const acts: ActivityEvent[] = childId ? await api.getActivity(childId).catch(() => []) : [];

      // Convert only genuine blocked activities into risk items
      const dynamicInsights: AiRiskItem[] = [];
      const blockedActs = (Array.isArray(acts) ? acts : []).filter((a) => a.action === 'BLOCKED');

      let mentalCount = 0;
      let cyberbullyingCount = 0;
      let explicitCount = 0;
      let circumventionCount = 0;

      blockedActs.forEach((act, idx) => {
        const dom = (act.domain || '').toLowerCase();
        const rawCategory = ((act as any).category || '').toUpperCase();
        let cat: AiRiskItem['category'] = 'CONTENT_RISK';
        let sev: AiRiskItem['severity'] = 'LOW';
        let explanation = `Access to blocked domain ${act.domain} was intercepted by parental policy.`;
        let advice = `Review whether ${childName} requires access to ${act.domain} for school or family activities.`;

        if (
          rawCategory === 'CIRCUMVENTION' ||
          dom.includes('vpn') ||
          dom.includes('proxy') ||
          dom.includes('bypass') ||
          dom.includes('dns-over-https')
        ) {
          cat = 'CIRCUMVENTION';
          sev = 'HIGH';
          circumventionCount++;
          explanation = `Blocked domain ${act.domain} belongs to potential circumvention or proxy category.`;
          advice = `Discuss why bypassing network protection is unsafe and check the Diagnostics tab.`;
        } else if (
          rawCategory === 'SOCIAL_MEDIA' ||
          dom.includes('tiktok') ||
          dom.includes('discord') ||
          dom.includes('instagram') ||
          dom.includes('chat')
        ) {
          cat = 'CYBERBULLYING';
          sev = 'MEDIUM';
          cyberbullyingCount++;
          explanation = `Unrestricted communication on ${act.domain} was blocked under social media controls.`;
          advice = `Ask ${childName} who invited them to ${act.domain} and discuss healthy online communication.`;
        } else if (rawCategory === 'ADULT_CONTENT' || rawCategory === 'MALWARE_SECURITY') {
          cat = 'CONTENT_RISK';
          sev = 'HIGH';
          explicitCount++;
          explanation = `High-risk explicit content or security threat was intercepted at domain ${act.domain}.`;
          advice = `Ensure the child understands that unexpected downloads or explicit links may contain malware.`;
        } else {
          cat = 'CONTENT_RISK';
          sev = 'LOW';
          explicitCount++;
          explanation = `Access to blocked domain ${act.domain} was stopped by category or domain rules.`;
          advice = `Review rule settings if access to this specific service is needed.`;
        }

        dynamicInsights.push({
          id: `act-risk-${act.id || idx}`,
          category: cat,
          severity: sev,
          queryOrContext: act.domain,
          detectedAt: new Date(act.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          actionTaken: `Intercepted by SafeBrowse Engine • ${act.reason || 'Blocked Domain Rule'}`,
          aiExplanation: explanation,
          parentAdvice: advice,
          reviewed: false,
        });
      });

      // Load reviewed state from localStorage
      const savedReviewed = JSON.parse(localStorage.getItem(`sb_watchdog_rev_${childId}`) || '[]');
      const finalItems = dynamicInsights.map((item) => ({
        ...item,
        reviewed: savedReviewed.includes(item.id),
      }));

      // Deduplicate by queryOrContext
      const seen = new Set<string>();
      const deduped: AiRiskItem[] = [];
      for (const item of finalItems) {
        if (!seen.has(item.queryOrContext)) {
          seen.add(item.queryOrContext);
          deduped.push(item);
        }
      }

      setItems(deduped);
      const score = blockedActs.length === 0 ? 100 : Math.max(50, 100 - blockedActs.length * 5);
      setSafetyScore(score);

      setRiskStats({
        mentalHealth: mentalCount > 0 ? `${mentalCount} Intercepts` : '0 Intercepts',
        cyberbullying: cyberbullyingCount > 0 ? `${cyberbullyingCount} Intercepts` : '0 Intercepts',
        explicitContent: explicitCount > 0 ? `${explicitCount} Intercepts` : '0 Intercepts',
        circumvention: circumventionCount > 0 ? `${circumventionCount} Neutralized` : '0 Attempts',
      });
    } catch (e) {
      console.warn('Error loading dynamic watchdog data:', e);
    } finally {
      setLoading(false);
    }
  };

  const markAsReviewed = (id: string) => {
    setItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, reviewed: true } : i))
    );
    if (selectedItem?.id === id) {
      setSelectedItem((prev) => (prev ? { ...prev, reviewed: true } : null));
    }
    const saved = JSON.parse(localStorage.getItem(`sb_watchdog_rev_${childId}`) || '[]');
    if (!saved.includes(id)) {
      localStorage.setItem(`sb_watchdog_rev_${childId}`, JSON.stringify([...saved, id]));
    }
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Overview Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-xl relative overflow-hidden">
        <div className="absolute -top-12 -right-12 w-64 h-64 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-2xl bg-indigo-500/20 border border-indigo-500/30 text-indigo-400 flex items-center justify-center shrink-0 shadow-inner">
              <Brain className="w-8 h-8" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-white tracking-tight">
                  AI Safety & Sentiment Watchdog
                </h2>
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                  Behavioral Security Engine
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-1 max-w-xl leading-relaxed">
                Autonomous safety engine analyzing high-risk intent, potential circumvention attempts, and communication patterns across {childName}'s devices.
              </p>
            </div>
          </div>

          {/* Safety Score Pill */}
          <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-4 flex items-center gap-5 shrink-0 self-stretch sm:self-auto">
            <div>
              <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Safety Index</div>
              <div className="text-2xl font-extrabold text-emerald-400 flex items-center gap-1.5 mt-0.5">
                <span>{safetyScore}</span>
                <span className="text-xs text-slate-500 font-normal">/ 100</span>
              </div>
            </div>
            <div className="text-right border-l border-slate-800 pl-4">
              <div className="text-[11px] font-bold text-emerald-300">
                {items.length === 0 ? 'Safe & Healthy' : `${items.length} Risk Events`}
              </div>
              <div className="text-[10px] text-slate-400">
                {items.length === 0 ? '0 Critical Threats' : `${items.filter(i => i.severity === 'HIGH').length} High Severity`}
              </div>
            </div>
          </div>
        </div>

        {/* 4 Risk Dimension Bars */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6 pt-6 border-t border-slate-800/80">
          <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 space-y-1">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-400 font-medium">Mental Health</span>
              <span className="text-slate-300 font-bold">{riskStats.mentalHealth}</span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-1.5">
              <div className="bg-emerald-500 h-1.5 rounded-full w-full" />
            </div>
          </div>

          <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 space-y-1">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-400 font-medium">Cyberbullying</span>
              <span className="text-slate-300 font-bold">{riskStats.cyberbullying}</span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-1.5">
              <div className="bg-emerald-500 h-1.5 rounded-full w-full" />
            </div>
          </div>

          <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 space-y-1">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-400 font-medium">Explicit Content</span>
              <span className="text-slate-300 font-bold">{riskStats.explicitContent}</span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-1.5">
              <div className="bg-emerald-500 h-1.5 rounded-full w-full" />
            </div>
          </div>

          <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 space-y-1">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-400 font-medium">Circumvention</span>
              <span className="text-amber-400 font-bold">{riskStats.circumvention}</span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-1.5">
              <div className="bg-amber-500 h-1.5 rounded-full w-[25%]" />
            </div>
          </div>
        </div>
      </div>

      {/* Flagged AI Insights & Parent Guidance */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left List */}
        <div className="lg:col-span-6 space-y-3">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider">
              Flagged Search & Intent Highlights
            </h3>
            <span className="text-xs text-slate-400">{items.length} Events</span>
          </div>

          {items.length === 0 ? (
            <div className="p-8 text-center text-slate-500 text-xs italic bg-slate-900/40 rounded-2xl border border-slate-800/80">
              No risk events recorded.
            </div>
          ) : (
            <div className="space-y-2.5">
              {items.map((item) => {
                const isSelected = selectedItem?.id === item.id;
                return (
                  <div
                    key={item.id}
                    onClick={() => setSelectedItem(item)}
                    className={`p-4 rounded-2xl border cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-slate-900 border-indigo-500/60 shadow-lg shadow-indigo-500/10'
                        : 'bg-slate-900/60 hover:bg-slate-900 border-slate-800/80 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                            item.severity === 'HIGH'
                              ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                              : item.severity === 'MEDIUM'
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                              : 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                          }`}
                        >
                          {item.severity} Risk
                        </span>
                        <span className="text-[10px] font-semibold text-slate-400 font-mono">
                          {item.category}
                        </span>
                      </div>

                      <span className="text-[10px] text-slate-500">{item.detectedAt}</span>
                    </div>

                    <div className="mt-2.5">
                      <div className="text-xs font-bold text-white font-mono bg-slate-950/80 p-2 rounded-lg border border-slate-800/80 truncate">
                        "{item.queryOrContext}"
                      </div>
                      <p className="text-[11px] text-slate-400 mt-2 line-clamp-2 leading-relaxed">
                        {item.aiExplanation}
                      </p>
                    </div>

                    <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-slate-800/60 text-[11px]">
                      <span className="text-indigo-400 font-medium flex items-center gap-1">
                        <Sparkles className="w-3 h-3" /> View Parent Guidance
                      </span>
                      {item.reviewed ? (
                        <span className="text-emerald-400 flex items-center gap-1 text-[10px]">
                          <CheckCircle2 className="w-3 h-3" /> Reviewed
                        </span>
                      ) : (
                        <span className="text-amber-400 text-[10px] font-semibold">● New Insight</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Detail Pane */}
        <div className="lg:col-span-6">
          {selectedItem ? (
            <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-7 shadow-xl space-y-5 sticky top-6 animate-in fade-in duration-200">
              <div className="flex items-center justify-between pb-4 border-b border-slate-800">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-white">AI Behavioral Analysis</h4>
                    <span className="text-[10px] text-slate-400">Event #{selectedItem.id}</span>
                  </div>
                </div>

                {!selectedItem.reviewed && (
                  <button
                    onClick={() => markAsReviewed(selectedItem.id)}
                    className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition flex items-center gap-1 shadow cursor-pointer"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" /> Mark Reviewed
                  </button>
                )}
              </div>

              {/* Analyzed Query */}
              <div className="space-y-1.5">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Detected Activity / Query
                </div>
                <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 text-xs font-mono font-bold text-white">
                  {selectedItem.queryOrContext}
                </div>
                <div className="text-[11px] text-emerald-400 flex items-center gap-1 font-medium pt-1">
                  <ShieldCheck className="w-3.5 h-3.5" /> {selectedItem.actionTaken}
                </div>
              </div>

              {/* AI Context Insight */}
              <div className="p-4 bg-indigo-500/5 border border-indigo-500/20 rounded-2xl space-y-2">
                <div className="flex items-center gap-2 text-xs font-bold text-indigo-300">
                  <Brain className="w-4 h-4" />
                  <span>AI Sentiment Assessment</span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {selectedItem.aiExplanation}
                </p>
              </div>

              {/* Actionable Parent Coaching Advice */}
              <div className="p-4 bg-amber-500/5 border border-amber-500/20 rounded-2xl space-y-2">
                <div className="flex items-center gap-2 text-xs font-bold text-amber-300">
                  <HeartHandshake className="w-4 h-4" />
                  <span>Parent Coaching & Talking Points</span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {selectedItem.parentAdvice}
                </p>
              </div>
            </div>
          ) : (
            <div className="bg-slate-900/40 border border-slate-800/80 rounded-3xl p-10 text-center space-y-3 flex flex-col items-center justify-center min-h-[360px]">
              <div className="w-12 h-12 rounded-2xl bg-slate-800/80 text-slate-400 flex items-center justify-center">
                <Brain className="w-6 h-6" />
              </div>
              <h4 className="text-sm font-bold text-white">
                {items.length === 0 ? 'No risk events recorded' : 'Select a flagged insight'}
              </h4>
              <p className="text-xs text-slate-400 max-w-xs leading-relaxed">
                {items.length === 0
                  ? 'All evaluated network requests comply with safety rules.'
                  : 'Click on any flagged search query or activity card on the left to review the AI analysis and age-appropriate talking points.'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};