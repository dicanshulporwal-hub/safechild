import React, { useState, useEffect } from 'react';
import { ShieldCheck, Printer, X, Trophy, CheckCircle, GraduationCap } from 'lucide-react';
import { api, ActivityEvent } from '../api/client';

interface WeeklySafetyDigestModalProps {
  childId?: string;
  childName: string;
  onClose: () => void;
}

export const WeeklySafetyDigestModal: React.FC<WeeklySafetyDigestModalProps> = ({
  childId,
  childName,
  onClose,
}) => {
  const [loading, setLoading] = useState(true);
  const [threatCount, setThreatCount] = useState(0);
  const [totalQueries, setTotalQueries] = useState(0);
  const [eduVisits, setEduVisits] = useState('0 visits');
  const [screenHours, setScreenHours] = useState('Not Available');
  const [safetyScore, setSafetyScore] = useState<number | null>(null);
  const [grade, setGrade] = useState<string>('N/A');
  const [categoryDist, setCategoryDist] = useState({
    education: 0,
    gaming: 0,
    social: 0,
    streaming: 0,
  });
  const [topEduDomains, setTopEduDomains] = useState<Array<{ domain: string; count: number }>>([]);

  useEffect(() => {
    fetchDigestData();
  }, [childId]);

  const fetchDigestData = async () => {
    if (!childId) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const [acts, tl, budgets] = await Promise.all([
        api.getActivity(childId).catch(() => []),
        api.getTimeline(childId).catch(() => []),
        api.getUsageBudgets(childId).catch(() => []),
      ]);

      const total = Array.isArray(acts) ? acts.length : 0;
      setTotalQueries(total);

      const blockedActs = (Array.isArray(acts) ? acts : []).filter((a) => a.action === 'BLOCKED');
      const realThreats = blockedActs.length;
      setThreatCount(realThreats);

      // Screen time from budgets
      if (Array.isArray(budgets) && budgets.length > 0) {
        const totalConsumedSec = budgets.reduce((acc: number, b: any) => acc + (b.consumedSeconds || 0), 0);
        if (totalConsumedSec > 0) {
          setScreenHours(`${(totalConsumedSec / 3600).toFixed(1)} hrs`);
        } else {
          setScreenHours('0.0 hrs');
        }
      } else {
        setScreenHours('Not Available');
      }

      if (total === 0) {
        setSafetyScore(100);
        setGrade('GRADE A');
        setEduVisits('0 visits');
        setCategoryDist({ education: 0, gaming: 0, social: 0, streaming: 0 });
        setTopEduDomains([]);
      } else {
        const calculatedScore = Math.max(50, Math.min(100, 100 - realThreats * 5));
        setSafetyScore(calculatedScore);
        setGrade(calculatedScore >= 90 ? 'GRADE A' : calculatedScore >= 75 ? 'GRADE B' : 'GRADE C');

        let edu = 0;
        let game = 0;
        let soc = 0;
        let stream = 0;

        const eduDomainsMap = new Map<string, number>();

        acts.forEach((a) => {
          const dom = (a.domain || '').toLowerCase();
          const cat = ((a as any).category || '').toUpperCase();

          if (
            cat === 'EDUCATION' ||
            dom.includes('.edu') ||
            dom.includes('khanacademy') ||
            dom.includes('wikipedia') ||
            dom.includes('duolingo') ||
            dom.includes('quizlet') ||
            dom.includes('coursera')
          ) {
            edu++;
            eduDomainsMap.set(dom, (eduDomainsMap.get(dom) || 0) + 1);
          } else if (cat === 'GAMING' || dom.includes('roblox') || dom.includes('steam') || dom.includes('minecraft')) {
            game++;
          } else if (cat === 'SOCIAL_MEDIA' || dom.includes('tiktok') || dom.includes('discord') || dom.includes('instagram')) {
            soc++;
          } else {
            stream++;
          }
        });

        const sum = edu + game + soc + stream;
        if (sum > 0) {
          const eduPct = Math.round((edu / sum) * 100);
          const gamePct = Math.round((game / sum) * 100);
          const socPct = Math.round((soc / sum) * 100);
          const streamPct = Math.max(0, 100 - eduPct - gamePct - socPct);
          setCategoryDist({
            education: eduPct,
            gaming: gamePct,
            social: socPct,
            streaming: streamPct,
          });
        }

        setEduVisits(`${edu} visit${edu === 1 ? '' : 's'}`);

        if (eduDomainsMap.size > 0) {
          const sorted = Array.from(eduDomainsMap.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([domain, count]) => ({
              domain,
              count,
            }));
          setTopEduDomains(sorted);
        } else {
          setTopEduDomains([]);
        }
      }
    } catch (e) {
      console.warn('Error fetching dynamic safety digest:', e);
    } finally {
      setLoading(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-2xl w-full p-6 sm:p-8 space-y-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-slate-800">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">📊</span>
              <h2 className="text-xl font-extrabold text-white tracking-tight">
                Weekly Family Safety Digest
              </h2>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Safety report card & learning analytics for <span className="text-white font-bold">{childName}</span> (Past 7 Days)
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handlePrint}
              className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition flex items-center gap-1.5 text-xs font-semibold cursor-pointer"
              title="Print or Save as PDF"
            >
              <Printer className="w-4 h-4" />
              <span className="hidden sm:inline">Print / PDF</span>
            </button>
            <button onClick={onClose} className="p-2 text-slate-400 hover:text-white rounded-xl cursor-pointer">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {loading ? (
          <div className="py-16 text-center text-slate-400 text-xs font-medium">
            Loading safety digest...
          </div>
        ) : (
          <>
            {/* Safety Score Card */}
            <div className="bg-gradient-to-r from-emerald-950/50 via-slate-950 to-slate-950 border border-emerald-500/30 rounded-2xl p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                  Overall Safety Rating
                </span>
                <div className="flex items-baseline gap-3 mt-1">
                  <span className="text-4xl font-black text-white">{safetyScore ?? '--'} / 100</span>
                  <span className="text-sm font-black text-emerald-300 bg-emerald-500/20 px-2.5 py-0.5 rounded-full border border-emerald-500/30">
                    {grade}
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  {totalQueries === 0
                    ? 'No activity recorded for this period.'
                    : threatCount === 0
                    ? 'Zero security breaches. All evaluated domains complied with protection policies.'
                    : `${threatCount} high-risk threat${threatCount === 1 ? '' : 's'} successfully intercepted and blocked.`}
                </p>
              </div>

              <div className="w-16 h-16 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0 shadow-lg shadow-emerald-500/10">
                <Trophy className="w-8 h-8" />
              </div>
            </div>

            {/* Threat Prevention Metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 text-center">
                <div className="text-2xl font-extrabold text-rose-400">{threatCount}</div>
                <div className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">Threats Blocked</div>
              </div>
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 text-center">
                <div className="text-2xl font-extrabold text-indigo-400">{eduVisits}</div>
                <div className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">Study & School</div>
              </div>
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 text-center">
                <div className="text-2xl font-extrabold text-blue-400">{screenHours}</div>
                <div className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">Screen Time Tracked</div>
              </div>
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 text-center">
                <div className="text-sm font-extrabold text-slate-400 pt-2 pb-1">Not Available</div>
                <div className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">Bedtime Adherence</div>
              </div>
            </div>

            {/* Category Breakdown Progress Bar */}
            <div className="bg-slate-950 p-5 rounded-2xl border border-slate-800 space-y-3">
              <h4 className="text-xs font-bold text-white uppercase tracking-wider">Browsing Category Distribution</h4>
              {totalQueries === 0 ? (
                <div className="text-xs text-slate-500 italic py-2">
                  No activity recorded for this period.
                </div>
              ) : (
                <>
                  <div className="w-full h-3 rounded-full bg-slate-800 overflow-hidden flex">
                    <div className="bg-emerald-500 h-full transition-all duration-500" style={{ width: `${categoryDist.education}%` }} title={`Education: ${categoryDist.education}%`}></div>
                    <div className="bg-indigo-500 h-full transition-all duration-500" style={{ width: `${categoryDist.gaming}%` }} title={`Gaming: ${categoryDist.gaming}%`}></div>
                    <div className="bg-blue-500 h-full transition-all duration-500" style={{ width: `${categoryDist.social}%` }} title={`Social: ${categoryDist.social}%`}></div>
                    <div className="bg-amber-500 h-full transition-all duration-500" style={{ width: `${categoryDist.streaming}%` }} title={`Streaming: ${categoryDist.streaming}%`}></div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 text-xs">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
                      <span className="text-slate-300 font-semibold">Education ({categoryDist.education}%)</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full bg-indigo-500"></span>
                      <span className="text-slate-300 font-semibold">Gaming ({categoryDist.gaming}%)</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full bg-blue-500"></span>
                      <span className="text-slate-300 font-semibold">Social Media ({categoryDist.social}%)</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span>
                      <span className="text-slate-300 font-semibold">Other ({categoryDist.streaming}%)</span>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Top Educational Highlights */}
            <div className="bg-slate-950 p-5 rounded-2xl border border-slate-800 space-y-3">
              <h4 className="text-xs font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                <GraduationCap className="w-4 h-4" />
                <span>Top Visited Educational Resources</span>
              </h4>
              {topEduDomains.length === 0 ? (
                <div className="text-xs text-slate-500 italic py-1">
                  No educational activity recorded.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  {topEduDomains.map((item) => (
                    <div key={item.domain} className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-between">
                      <span className="font-mono text-white truncate max-w-[200px]">{item.domain}</span>
                      <span className="text-emerald-400 font-bold">{item.count} visit{item.count === 1 ? '' : 's'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* Footer */}
        <div className="flex justify-end pt-2 border-t border-slate-800">
          <button
            onClick={onClose}
            className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition shadow cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
