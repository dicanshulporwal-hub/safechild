import React from 'react';
import { TimelineEvent } from '@safebrowse/protocol';
import { Clock, ShieldAlert, CheckCircle2, RefreshCw, Wifi, Moon, BookOpen, Activity } from 'lucide-react';

interface ProtectionTimelineProps {
  childName: string;
  events: TimelineEvent[];
}

export const ProtectionTimeline: React.FC<ProtectionTimelineProps> = ({ childName, events }) => {
  const getEventIcon = (type: string, decision?: string) => {
    switch (type) {
      case 'BLOCKED':
        return <ShieldAlert className="w-4 h-4 text-rose-400" />;
      case 'ALLOWED':
      case 'TEMP_GRANT':
        return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
      case 'POLICY_APPLIED':
      case 'PROTECTION_RESTARTED':
        return <RefreshCw className="w-4 h-4 text-indigo-400" />;
      case 'NETWORK_SWITCH':
        return <Wifi className="w-4 h-4 text-amber-400" />;
      default:
        return <Clock className="w-4 h-4 text-slate-400" />;
    }
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800/90 rounded-3xl p-6 sm:p-8 shadow-2xl backdrop-blur-xl space-y-6">
      <div className="flex items-center justify-between pb-5 border-b border-slate-800/80">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-cyan-500/20 to-blue-500/20 border border-cyan-500/30 text-cyan-400 flex items-center justify-center shadow-inner">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-extrabold text-white tracking-tight">Protection Audit Timeline</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Auditable, privacy-first live security timeline for {childName}'s devices.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-2.5">
        {events.length === 0 ? (
          <div className="text-center py-8 text-xs text-slate-500 font-semibold bg-slate-950/40 rounded-2xl border border-slate-800/60">
            No security timeline events recorded yet today.
          </div>
        ) : (
          events.slice(0, 15).map((evt) => (
            <div
              key={evt.id}
              className="p-4 rounded-2xl bg-slate-950/60 border border-slate-800/80 flex items-start gap-3.5 text-xs transition-all hover:bg-slate-950/90 hover:border-slate-700/80"
            >
              <div className="mt-0.5 w-8 h-8 rounded-xl bg-slate-900 shadow-sm border border-slate-700/80 flex items-center justify-center shrink-0">
                {getEventIcon(evt.eventType, evt.decision)}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="font-extrabold text-white truncate font-mono">
                    {evt.domain || evt.reason}
                  </span>
                  <span className="text-[10px] text-slate-400 font-mono font-bold ml-2 shrink-0">
                    {new Date(evt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>

                <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-1">
                  <span className="font-semibold text-slate-300">{evt.deviceName}</span>
                  <span>•</span>
                  <span>{evt.reason}</span>
                  <span>•</span>
                  <span className="font-mono text-emerald-400 font-bold">v{evt.policyVersion}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
