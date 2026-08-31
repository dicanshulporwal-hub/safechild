import React, { useState } from 'react';
import { AccessRequest } from '../api/client';
import { Clock, CheckCircle, XCircle, ShieldQuestion, Globe, Smartphone, User, Sparkles } from 'lucide-react';

interface AskParentModalProps {
  requests: AccessRequest[];
  onResolve: (requestId: string, action: 'APPROVE' | 'DENY', duration?: string) => void;
  onClose: () => void;
}

export const AskParentModal: React.FC<AskParentModalProps> = ({
  requests,
  onResolve,
  onClose,
}) => {
  const [processingId, setProcessingId] = useState<string | null>(null);

  const handleAction = async (requestId: string, action: 'APPROVE' | 'DENY', duration?: string) => {
    try {
      setProcessingId(requestId);
      await onResolve(requestId, action, duration);
    } finally {
      setProcessingId(null);
    }
  };

  const pendingRequests = requests.filter((r) => r.status === 'PENDING');

  return (
    <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn">
      <div className="bg-white rounded-3xl max-w-xl w-full p-6 sm:p-8 shadow-2xl border border-slate-100 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-4 border-b border-slate-100">
          <div className="flex items-center space-x-2.5">
            <div className="w-9 h-9 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center font-bold">
              <ShieldQuestion className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-xl font-extrabold text-slate-900 tracking-tight">
                Access Requests
              </h3>
              <p className="text-xs text-slate-500">
                {pendingRequests.length} pending request{pendingRequests.length > 1 ? 's' : ''} from your children
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-1.5 rounded-xl hover:bg-slate-100"
          >
            ✕
          </button>
        </div>

        <div className="mt-6 space-y-5">
          {pendingRequests.length === 0 ? (
            <div className="text-center py-12 text-slate-400 text-sm">
              <CheckCircle className="w-10 h-10 text-emerald-500 mx-auto mb-2 opacity-80" />
              <p className="font-bold text-slate-700">All Caught Up!</p>
              <p className="text-xs text-slate-400 mt-1">No pending access requests at this time.</p>
            </div>
          ) : (
            pendingRequests.map((req) => (
              <div
                key={req.id}
                className="bg-slate-50 border border-slate-200/90 rounded-2xl p-5 shadow-sm space-y-4"
              >
                {/* Request Header */}
                <div className="flex items-start justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 rounded-xl bg-red-100 text-red-600 flex items-center justify-center font-black">
                      <Globe className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="text-base font-extrabold text-slate-900">{req.domain}</div>
                      <div className="flex items-center space-x-3 text-xs text-slate-500 mt-0.5">
                        <span className="flex items-center gap-1">
                          <Smartphone className="w-3 h-3 text-slate-400" />
                          {req.deviceName || 'Child Device'}
                        </span>
                        <div className="text-[10px] text-slate-400">
                  {new Date(req.requestedAt || req.createdAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>      </div>
                    </div>
                  </div>

                  <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 uppercase tracking-wider">
                    Requested
                  </span>
                </div>

                {/* Reason Box */}
                {req.reason && (
                  <div className="bg-white p-3.5 rounded-xl border border-slate-200 text-xs text-slate-700 italic">
                    <span className="font-bold not-italic text-slate-900 block mb-0.5">Reason provided:</span>
                    "{req.reason}"
                  </div>
                )}

                {/* Action Buttons */}
                <div className="pt-2">
                  <div className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-2">
                    Approve Temporary Access
                  </div>
                  
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <button
                      disabled={processingId === req.id}
                      onClick={() => handleAction(req.id, 'APPROVE', '15m')}
                      className="py-2 px-2.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-300 font-bold text-xs flex items-center justify-center gap-1 transition-all"
                    >
                      <Clock className="w-3 h-3 text-emerald-600" />
                      <span>15 Mins</span>
                    </button>

                    <button
                      disabled={processingId === req.id}
                      onClick={() => handleAction(req.id, 'APPROVE', '1h')}
                      className="py-2 px-2.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-300 font-bold text-xs flex items-center justify-center gap-1 transition-all"
                    >
                      <Clock className="w-3 h-3 text-emerald-600" />
                      <span>1 Hour</span>
                    </button>

                    <button
                      disabled={processingId === req.id}
                      onClick={() => handleAction(req.id, 'APPROVE', 'today')}
                      className="py-2 px-2.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-300 font-bold text-xs flex items-center justify-center gap-1 transition-all"
                    >
                      <Clock className="w-3 h-3 text-emerald-600" />
                      <span>Today</span>
                    </button>

                    <button
                      disabled={processingId === req.id}
                      onClick={() => handleAction(req.id, 'APPROVE', 'always')}
                      className="py-2 px-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center justify-center gap-1 shadow-sm transition-all"
                    >
                      <Sparkles className="w-3 h-3 text-emerald-200" />
                      <span>Always</span>
                    </button>
                  </div>

                  <div className="mt-2 text-right">
                    <button
                      disabled={processingId === req.id}
                      onClick={() => handleAction(req.id, 'DENY')}
                      className="inline-flex items-center space-x-1 py-1.5 px-3 text-xs font-bold text-red-600 hover:bg-red-50 rounded-xl transition-all"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      <span>Deny Request</span>
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
