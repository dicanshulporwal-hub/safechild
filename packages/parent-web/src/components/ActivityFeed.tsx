import React from 'react';
import { ActivityEvent } from '../api/client';
import { ShieldAlert, ShieldCheck, Clock, Smartphone, Lock } from 'lucide-react';

interface ActivityFeedProps {
  childName: string;
  activities: ActivityEvent[];
}

export const ActivityFeed: React.FC<ActivityFeedProps> = ({ childName, activities }) => {
  const formatTime = (timeStr: string) => {
    return new Date(timeStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="bg-white rounded-3xl p-6 sm:p-7 shadow-sm border border-slate-200/80">
      <div className="flex items-center justify-between pb-4 border-b border-slate-100">
        <div>
          <h3 className="text-xl font-black text-slate-900 tracking-tight">Recent Activity</h3>
          <p className="text-xs text-slate-500 font-medium mt-0.5">
            Privacy-conscious safety events for {childName}.
          </p>
        </div>

        <div className="flex items-center space-x-1 text-[11px] font-bold text-slate-500 bg-slate-100 px-3 py-1 rounded-full">
          <Lock className="w-3 h-3 text-slate-400" />
          <span>Privacy-First</span>
        </div>
      </div>

      <div className="mt-5 space-y-2.5">
        {activities.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-sm">
            No activity events recorded today yet.
          </div>
        ) : (
          activities.slice(0, 8).map((act) => {
            const isBlocked = act.action === 'BLOCKED';
            const isTemp = act.action === 'TEMPORARY_ACCESSED';

            return (
              <div
                key={act.id}
                className="flex items-center justify-between p-3.5 rounded-2xl bg-slate-50 border border-slate-100 text-xs"
              >
                <div className="flex items-center space-x-3">
                  <div
                    className={`w-7 h-7 rounded-lg flex items-center justify-center font-bold ${
                      isBlocked
                        ? 'bg-red-100 text-red-600'
                        : isTemp
                        ? 'bg-amber-100 text-amber-600'
                        : 'bg-emerald-100 text-emerald-600'
                    }`}
                  >
                    {isBlocked ? (
                      <ShieldAlert className="w-4 h-4" />
                    ) : isTemp ? (
                      <Clock className="w-4 h-4" />
                    ) : (
                      <ShieldCheck className="w-4 h-4" />
                    )}
                  </div>
                  <div>
                    <span className="font-extrabold text-slate-900 text-sm">{act.domain}</span>
                    <div className="flex items-center space-x-2 text-[11px] text-slate-400 mt-0.5">
                      <span className="flex items-center gap-1">
                        <Smartphone className="w-3 h-3" />
                        {act.deviceName}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="text-right">
                  <span
                    className={`px-2 py-0.5 rounded-md font-black text-[10px] uppercase tracking-wider ${
                      isBlocked
                        ? 'bg-red-100 text-red-700'
                        : isTemp
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-emerald-100 text-emerald-700'
                    }`}
                  >
                    {act.action}
                  </span>
                  <div className="text-[10px] text-slate-400 mt-0.5">{formatTime(act.timestamp)}</div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="mt-5 p-3.5 rounded-2xl bg-slate-50 border border-slate-200/60 flex items-start space-x-2.5 text-slate-500 text-[11px]">
        <Lock className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
        <span>
          SafeBrowse collects only domain names and timestamps for safety events. Search keywords, page contents, and browsing histories are never collected or stored.
        </span>
      </div>
    </div>
  );
};
