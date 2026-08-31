import React, { useState } from 'react';
import { Child, Policy } from '../api/client';
import { PauseCircle, PlayCircle, ShieldAlert, PlusCircle, Clock, Zap } from 'lucide-react';

interface QuickControlsProps {
  child: Child;
  policy: Policy | null;
  stats: { todayBlockedCount: number; pendingRequestsCount: number };
  onTogglePause: (isPaused: boolean, duration?: string) => void;
  onOpenAddRule: () => void;
  onOpenRequests: () => void;
}

export const QuickControls: React.FC<QuickControlsProps> = ({
  child,
  policy,
  stats,
  onTogglePause,
  onOpenAddRule,
  onOpenRequests,
}) => {
  const [showPauseOptions, setShowPauseOptions] = useState(false);
  const isPaused = policy?.isPaused || false;

  return (
    <div className="bg-white rounded-3xl p-6 sm:p-7 shadow-sm border border-slate-200/80 mb-8">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
        
        {/* Child Overview & Status */}
        <div className="flex items-start sm:items-center space-x-4">
          <div className="w-16 h-16 rounded-2xl bg-emerald-50 border border-emerald-100 flex items-center justify-center text-3xl shadow-inner">
            {child.avatar || '🧑'}
          </div>
          <div>
            <div className="flex items-center space-x-2.5">
              <h2 className="text-2xl font-black text-slate-900 tracking-tight">{child.name}</h2>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                Protected
              </span>
              <span className="text-xs font-semibold px-2 py-0.5 bg-slate-100 text-slate-600 rounded-md">
                Policy v{policy?.version || 1}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1 font-medium">
              Rules apply synchronously across all of {child.name}'s connected devices.
            </p>
          </div>
        </div>

        {/* Quick Stats Badges */}
        <div className="grid grid-cols-2 sm:grid-cols-2 gap-3 sm:gap-4">
          <div className="bg-slate-50 border border-slate-100 rounded-2xl p-3.5 flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-red-100 text-red-600 flex items-center justify-center">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <div className="text-xl font-black text-slate-900">{stats.todayBlockedCount}</div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Blocked Today</div>
            </div>
          </div>

          <div
            onClick={onOpenRequests}
            className={`cursor-pointer rounded-2xl p-3.5 flex items-center space-x-3 border transition-all ${
              stats.pendingRequestsCount > 0
                ? 'bg-amber-50 border-amber-200 text-amber-900 shadow-sm hover:bg-amber-100/70'
                : 'bg-slate-50 border-slate-100 text-slate-900'
            }`}
          >
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                stats.pendingRequestsCount > 0 ? 'bg-amber-500 text-white' : 'bg-slate-200 text-slate-600'
              }`}
            >
              <Clock className="w-5 h-5" />
            </div>
            <div>
              <div className="text-xl font-black">{stats.pendingRequestsCount}</div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Access Requests</div>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Pause / Resume Button */}
          {isPaused ? (
            <button
              onClick={() => onTogglePause(false)}
              className="flex items-center space-x-2 px-5 py-3 rounded-2xl font-bold text-sm bg-emerald-600 hover:bg-emerald-700 text-white shadow-md shadow-emerald-600/25 transition-all"
            >
              <PlayCircle className="w-5 h-5" />
              <span>Resume Internet</span>
            </button>
          ) : (
            <div className="relative">
              <button
                onClick={() => setShowPauseOptions(!showPauseOptions)}
                className="flex items-center space-x-2 px-5 py-3 rounded-2xl font-bold text-sm bg-amber-500 hover:bg-amber-600 text-white shadow-md shadow-amber-500/20 transition-all"
              >
                <PauseCircle className="w-5 h-5" />
                <span>Pause {child.name}'s Internet</span>
              </button>

              {/* Pause Duration Dropdown */}
              {showPauseOptions && (
                <div className="absolute right-0 mt-2 w-52 bg-white rounded-2xl shadow-xl border border-slate-100 p-2 z-20 animate-fadeIn">
                  <div className="text-[11px] font-bold text-slate-400 px-3 py-1 uppercase tracking-wider">
                    Pause Duration
                  </div>
                  <button
                    onClick={() => {
                      onTogglePause(true, '15m');
                      setShowPauseOptions(false);
                    }}
                    className="w-full text-left px-3 py-2 rounded-xl text-xs font-bold text-slate-700 hover:bg-slate-100 flex items-center justify-between"
                  >
                    <span>15 Minutes</span>
                    <Clock className="w-3.5 h-3.5 text-slate-400" />
                  </button>
                  <button
                    onClick={() => {
                      onTogglePause(true, '30m');
                      setShowPauseOptions(false);
                    }}
                    className="w-full text-left px-3 py-2 rounded-xl text-xs font-bold text-slate-700 hover:bg-slate-100 flex items-center justify-between"
                  >
                    <span>30 Minutes</span>
                    <Clock className="w-3.5 h-3.5 text-slate-400" />
                  </button>
                  <button
                    onClick={() => {
                      onTogglePause(true, '1h');
                      setShowPauseOptions(false);
                    }}
                    className="w-full text-left px-3 py-2 rounded-xl text-xs font-bold text-slate-700 hover:bg-slate-100 flex items-center justify-between"
                  >
                    <span>1 Hour</span>
                    <Clock className="w-3.5 h-3.5 text-slate-400" />
                  </button>
                  <button
                    onClick={() => {
                      onTogglePause(true, 'indefinite');
                      setShowPauseOptions(false);
                    }}
                    className="w-full text-left px-3 py-2 rounded-xl text-xs font-bold text-amber-700 hover:bg-amber-50 flex items-center justify-between"
                  >
                    <span>Until Resumed</span>
                    <Zap className="w-3.5 h-3.5 text-amber-500" />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Quick Block Website Button */}
          <button
            onClick={onOpenAddRule}
            className="flex items-center space-x-2 px-5 py-3 rounded-2xl font-bold text-sm bg-slate-900 hover:bg-slate-800 text-white shadow-md shadow-slate-900/15 transition-all"
          >
            <PlusCircle className="w-5 h-5 text-emerald-400" />
            <span>+ Block Website</span>
          </button>
        </div>

      </div>

      {/* Internet Paused Banner Warning */}
      {isPaused && (
        <div className="mt-5 p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <PauseCircle className="w-5 h-5 text-amber-600" />
            <div>
              <span className="font-extrabold text-amber-900 text-sm">Internet is currently paused for {child.name}</span>
              <p className="text-xs text-amber-700">
                {policy?.pauseExpiresAt
                  ? `Active until ${new Date(policy.pauseExpiresAt).toLocaleTimeString()}`
                  : 'Active until manually resumed'}
              </p>
            </div>
          </div>
          <button
            onClick={() => onTogglePause(false)}
            className="px-3.5 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold shadow-sm"
          >
            Resume Now
          </button>
        </div>
      )}
    </div>
  );
};
