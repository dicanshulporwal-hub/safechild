import React from 'react';
import { TimelineEvent } from '@safebrowse/protocol';
import { Clock, ShieldAlert, CheckCircle2, RefreshCw, Wifi, Moon, BookOpen } from 'lucide-react';

interface ProtectionTimelineProps {
  childName: string;
  events: TimelineEvent[];
}

export const ProtectionTimeline: React.FC<ProtectionTimelineProps> = ({ childName, events }) => {
  const getEventIcon = (type: string, decision?: string) => {
    switch (type) {
      case 'BLOCKED':
        return <ShieldAlert className="w-4 h-4 text-red-500" />;
      case 'ALLOWED':
      case 'TEMP_GRANT':
        return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
      case 'POLICY_APPLIED':
      case 'PROTECTION_RESTARTED':
        return <RefreshCw className="w-4 h-4 text-indigo-500" />;
      case 'NETWORK_SWITCH':
        return <Wifi className="w-4 h-4 text-amber-500" />;
      default:
        return <Clock className="w-4 h-4 text-slate-400" />;
    }
  };

  return (
    <div className="bg-white rounded-3xl p-6 sm:p-7 shadow-sm border border-slate-200/80">
      <div className="flex items-center justify-between pb-5 border-b border-slate-100">
        <div>
          <h3 className="text-xl font-black text-slate-900 tracking-tight">Protection Timeline</h3>
          <p className="text-xs text-slate-500 font-medium mt-0.5">
            Auditable, privacy-first security timeline for {childName}'s devices.
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-3">
        {events.length === 0 ? (
          <div className="text-center py-6 text-xs text-slate-400 font-semibold">
            No security timeline events recorded yet today.
          </div>
        ) : (
          events.slice(0, 10).map((evt) => (
            <div
              key={evt.id}
              className="p-3.5 rounded-2xl bg-slate-50 border border-slate-100 flex items-start space-x-3 text-xs"
            >
              <div className="mt-0.5 w-7 h-7 rounded-xl bg-white shadow-xs border border-slate-200/60 flex items-center justify-center shrink-0">
                {getEventIcon(evt.eventType, evt.decision)}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="font-extrabold text-slate-900 truncate">
                    {evt.domain || evt.reason}
                  </span>
                  <span className="text-[10px] text-slate-400 font-bold ml-2 shrink-0">
                    {new Date(evt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>

                <div className="flex items-center space-x-2 text-[11px] text-slate-500 mt-0.5">
                  <span className="font-semibold">{evt.deviceName}</span>
                  <span>•</span>
                  <span>{evt.reason}</span>
                  <span>•</span>
                  <span className="font-bold text-slate-700">v{evt.policyVersion}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
