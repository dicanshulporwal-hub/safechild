import React, { useState } from 'react';
import { Policy } from '../api/client';
import { BookOpen, Moon, Clock, Sparkles, Calendar, CheckCircle2, ChevronRight, School, Coffee } from 'lucide-react';

interface RoutinesCardProps {
  childName: string;
  policy: Policy | null;
  onToggleStudyMode: (active: boolean) => void;
  onToggleBedtime: (enabled: boolean) => void;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const RoutinesCard: React.FC<RoutinesCardProps> = ({
  childName,
  policy,
  onToggleStudyMode,
  onToggleBedtime,
}) => {
  const [selectedDay, setSelectedDay] = useState('Mon');
  const isStudyModeActive = Boolean((policy as any)?.studyMode?.active);
  const isBedtimeActive = Boolean((policy as any)?.bedtime?.enabled);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6">
      <div className="flex items-center justify-between pb-3 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-indigo-400" />
            <h3 className="text-sm font-bold text-white uppercase tracking-wider">Smart Schedules & Routines</h3>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Automated school hours, bedtime curfew, and study routines for {childName}.
          </p>
        </div>
      </div>

      {/* Quick Active Routine Toggles */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Study Mode Routine */}
        <div
          className={`p-4 rounded-xl border transition-all flex items-center justify-between ${
            isStudyModeActive
              ? 'bg-emerald-950/25 border-emerald-500/40 shadow-inner'
              : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
          }`}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center shrink-0">
              <BookOpen className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-xs text-white">Study Mode</span>
                {isStudyModeActive && (
                  <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                    Active
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">
                Only educational websites permitted.
              </p>
            </div>
          </div>

          <button
            onClick={() => onToggleStudyMode(!isStudyModeActive)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
              isStudyModeActive
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
            }`}
          >
            {isStudyModeActive ? 'End Mode' : 'Start Mode'}
          </button>
        </div>

        {/* Bedtime Routine */}
        <div
          className={`p-4 rounded-xl border transition-all flex items-center justify-between ${
            isBedtimeActive
              ? 'bg-indigo-950/25 border-indigo-500/40 shadow-inner'
              : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
          }`}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 flex items-center justify-center shrink-0">
              <Moon className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-xs text-white">Bedtime Curfew</span>
                {isBedtimeActive && (
                  <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                    9:30 PM – 7:00 AM
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">
                Locks all entertainment websites overnight.
              </p>
            </div>
          </div>

          <button
            onClick={() => onToggleBedtime(!isBedtimeActive)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
              isBedtimeActive
                ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
            }`}
          >
            {isBedtimeActive ? 'Enabled' : 'Enable'}
          </button>
        </div>
      </div>

      {/* 7-Day Visual Timetable */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-white uppercase tracking-wider">Weekly Schedule Timetable</span>
          <div className="flex gap-1">
            {DAYS.map((d) => (
              <button
                key={d}
                onClick={() => setSelectedDay(d)}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition ${
                  selectedDay === d
                    ? 'bg-indigo-600 text-white shadow'
                    : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        {/* Day Schedule Breakdown */}
        <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between text-xs pb-2 border-b border-slate-800/80">
            <span className="font-bold text-white">{selectedDay}day Routine Schedule</span>
            <span className="text-emerald-400 font-medium">Automatic Enforcement Active</span>
          </div>

          <div className="space-y-2">
            {/* School Block */}
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(selectedDay) && (
              <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-between text-xs">
                <div className="flex items-center gap-2.5">
                  <span className="p-1.5 rounded-md bg-blue-500/20 text-blue-300">
                    <School className="w-3.5 h-3.5" />
                  </span>
                  <div>
                    <div className="font-bold text-white">School Hours (08:00 AM – 02:30 PM)</div>
                    <div className="text-[10px] text-slate-400">Restricted to School, Wikipedia, and Educational Portals</div>
                  </div>
                </div>
                <span className="text-[10px] bg-blue-500/20 text-blue-300 border border-blue-500/30 px-2 py-0.5 rounded-full font-bold">
                  School Mode
                </span>
              </div>
            )}

            {/* Free Time */}
            <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-between text-xs">
              <div className="flex items-center gap-2.5">
                <span className="p-1.5 rounded-md bg-emerald-500/20 text-emerald-300">
                  <Coffee className="w-3.5 h-3.5" />
                </span>
                <div>
                  <div className="font-bold text-white">Free Time & Homework (03:00 PM – 08:00 PM)</div>
                  <div className="text-[10px] text-slate-400">Safe browsing allowed within daily screen time limits</div>
                </div>
              </div>
              <span className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-full font-bold">
                Filtered
              </span>
            </div>

            {/* Bedtime */}
            <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-between text-xs">
              <div className="flex items-center gap-2.5">
                <span className="p-1.5 rounded-md bg-indigo-500/20 text-indigo-300">
                  <Moon className="w-3.5 h-3.5" />
                </span>
                <div>
                  <div className="font-bold text-white">Bedtime Curfew (09:30 PM – 07:00 AM)</div>
                  <div className="text-[10px] text-slate-400">All non-emergency internet access locked</div>
                </div>
              </div>
              <span className="text-[10px] bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-2 py-0.5 rounded-full font-bold">
                Locked
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
