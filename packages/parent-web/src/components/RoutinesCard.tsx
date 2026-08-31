import React, { useState } from 'react';
import { Policy } from '../api/client';
import { BookOpen, Moon, Clock, Sparkles } from 'lucide-react';

interface RoutinesCardProps {
  childName: string;
  policy: Policy | null;
  onToggleStudyMode: (active: boolean) => void;
  onToggleBedtime: (enabled: boolean) => void;
}

export const RoutinesCard: React.FC<RoutinesCardProps> = ({
  childName,
  policy,
  onToggleStudyMode,
  onToggleBedtime,
}) => {
  const isStudyModeActive = Boolean((policy as any)?.studyMode?.active);
  const isBedtimeActive = Boolean((policy as any)?.bedtime?.enabled);

  return (
    <div className="bg-white rounded-3xl p-6 sm:p-7 shadow-sm border border-slate-200/80">
      <div className="flex items-center justify-between pb-5 border-b border-slate-100">
        <div>
          <h3 className="text-xl font-black text-slate-900 tracking-tight">Smart Routines</h3>
          <p className="text-xs text-slate-500 font-medium mt-0.5">
            Automated study and bedtime schedules for {childName}.
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-4">
        {/* Study Mode Routine */}
        <div
          className={`p-5 rounded-2xl border transition-all ${
            isStudyModeActive
              ? 'bg-emerald-50/70 border-emerald-300'
              : 'bg-slate-50 border-slate-200/80'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3.5">
              <div className="w-11 h-11 rounded-2xl bg-emerald-600 text-white flex items-center justify-center shadow-md shadow-emerald-600/20">
                <BookOpen className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <span className="font-extrabold text-sm text-slate-900">📚 Study Mode</span>
                  {isStudyModeActive && (
                    <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-emerald-200 text-emerald-800 animate-pulse">
                      Active
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Blocks all games, social media, & entertainment. Only educational sites allowed.
                </p>
              </div>
            </div>

            <button
              onClick={() => onToggleStudyMode(!isStudyModeActive)}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                isStudyModeActive
                  ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-md'
                  : 'bg-slate-900 hover:bg-slate-800 text-white'
              }`}
            >
              {isStudyModeActive ? 'Turn Off' : 'Turn On'}
            </button>
          </div>
        </div>

        {/* Bedtime Routine */}
        <div
          className={`p-5 rounded-2xl border transition-all ${
            isBedtimeActive
              ? 'bg-indigo-50/70 border-indigo-300'
              : 'bg-slate-50 border-slate-200/80'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3.5">
              <div className="w-11 h-11 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-md shadow-indigo-600/20">
                <Moon className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <span className="font-extrabold text-sm text-slate-900">🌙 Bedtime Routine</span>
                  {isBedtimeActive && (
                    <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-indigo-200 text-indigo-800">
                      9:30 PM — 7:00 AM
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Automatically disables entertainment websites at night.
                </p>
              </div>
            </div>

            <button
              onClick={() => onToggleBedtime(!isBedtimeActive)}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                isBedtimeActive
                  ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-md'
                  : 'bg-slate-900 hover:bg-slate-800 text-white'
              }`}
            >
              {isBedtimeActive ? 'Enabled' : 'Enable'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
