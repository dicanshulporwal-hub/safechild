import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useToast } from '../components/Toast';
import { api, AccessRequest, Child } from '../api/client';

export const RequestsPage: React.FC = () => {
  const { requestId } = useParams();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [childrenMap, setChildrenMap] = useState<Record<string, Child>>({});
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  useEffect(() => {
    fetchRequests();
  }, []);

  const fetchRequests = async () => {
    setLoading(true);
    try {
      const [reqs, kids] = await Promise.all([
        api.getAllRequests().catch(() => []),
        api.getChildren().catch(() => []),
      ]);
      setRequests(reqs);
      const map: Record<string, Child> = {};
      kids.forEach((k) => (map[k.id] = k));
      setChildrenMap(map);
    } catch (e) {
      console.error('Error fetching requests:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleResolve = async (reqId: string, action: 'APPROVE' | 'DENY', duration?: string) => {
    setResolvingId(reqId);
    try {
      const data = await api.resolveRequest(reqId, action, duration);
      showToast(
        action === 'APPROVE'
          ? `Approved ${duration || 'temporary'} access for ${data.request?.domain}`
          : `Denied access for ${data.request?.domain}`,
        action === 'APPROVE' ? 'success' : 'info'
      );
      fetchRequests();
    } catch (e: any) {
      showToast(e.message || 'Failed to resolve request', 'error');
    } finally {
      setResolvingId(null);
    }
  };

  const pendingRequests = requests.filter((r) => r.status === 'PENDING');
  const resolvedRequests = requests.filter((r) => r.status !== 'PENDING');

  const selectedRequest =
    (requestId && requests.find((r) => r.id === requestId)) ||
    pendingRequests[0] ||
    requests[0] ||
    null;

  if (loading) {
    return <div className="p-8 text-center text-slate-400">Loading access requests...</div>;
  }

  return (
    <div className="max-w-6xl space-y-6 animate-fadeIn">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">Ask Parent Requests</h1>
          <p className="text-xs text-slate-400 mt-1">Review, approve, and grant temporary web unlocks requested by your children.</p>
        </div>
        <span className="px-3.5 py-1.5 bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded-full text-xs font-extrabold shadow-sm">
          {pendingRequests.length} Action Item{pendingRequests.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Request List */}
        <div className="lg:col-span-5 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400">
              Pending Requests ({pendingRequests.length})
            </span>
          </div>

          <div className="space-y-2.5">
            {pendingRequests.length === 0 ? (
              <div className="p-8 bg-slate-900/80 border border-slate-800/80 rounded-3xl text-center space-y-2">
                <div className="text-2xl">🎉</div>
                <div className="text-xs font-bold text-white">Inbox Zero</div>
                <div className="text-[11px] text-slate-400">No pending website unlock requests right now.</div>
              </div>
            ) : (
              pendingRequests.map((req) => {
                const child = childrenMap[req.childId];
                const isSelected = selectedRequest?.id === req.id;
                const reqDate = new Date(req.createdAt || req.requestedAt || Date.now());
                return (
                  <div
                    key={req.id}
                    onClick={() => navigate(`/requests/${req.id}`)}
                    className={`p-4 rounded-2xl border cursor-pointer transition-all duration-200 ${
                      isSelected
                        ? 'bg-amber-500/10 border-amber-500/50 shadow-xl shadow-amber-500/10 scale-[1.01]'
                        : 'bg-slate-900/80 border-slate-800/80 hover:border-slate-700/80 hover:bg-slate-900'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-extrabold text-white flex items-center gap-2">
                        <span className="text-base">{child?.avatar || '🧑'}</span>
                        <span>{child?.name || 'Child'}</span>
                      </span>
                      <span className="text-[10px] text-slate-500 font-mono">
                        {reqDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <div className="text-sm font-extrabold text-amber-300 font-mono">{req.domain}</div>
                    {req.reason && <div className="text-xs text-slate-300 mt-1 italic line-clamp-2">"{req.reason}"</div>}
                  </div>
                );
              })
            )}
          </div>

          {resolvedRequests.length > 0 && (
            <div className="pt-4 space-y-2">
              <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">
                Resolved Activity ({resolvedRequests.length})
              </span>
              <div className="space-y-2">
                {resolvedRequests.slice(0, 5).map((req) => {
                  const child = childrenMap[req.childId];
                  const resDate = new Date(req.resolvedAt || req.createdAt || req.requestedAt || Date.now());
                  return (
                    <div
                      key={req.id}
                      onClick={() => navigate(`/requests/${req.id}`)}
                      className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-xl cursor-pointer hover:border-slate-700 flex items-center justify-between text-xs"
                    >
                      <div>
                        <div className="font-semibold text-slate-300">
                          {child?.name} • <span className="font-mono text-slate-200">{req.domain}</span>
                        </div>
                        <div className="text-[10px] text-slate-500">
                          {req.resolvedByName ? `By ${req.resolvedByName}` : 'Resolved'} • {resDate.toLocaleDateString()}
                        </div>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                        req.status === 'APPROVED' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'
                      }`}>
                        {req.status}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Decision Pane */}
        <div className="lg:col-span-7">
          {selectedRequest ? (
            <div className="bg-slate-900/90 border border-slate-800/90 rounded-3xl p-6 sm:p-8 space-y-6 shadow-2xl backdrop-blur-xl sticky top-20">
              <div className="flex items-center justify-between pb-4 border-b border-slate-800/80">
                <div>
                  <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400">Unlock Request</span>
                  <h2 className="text-xl sm:text-2xl font-extrabold text-white font-mono mt-0.5">{selectedRequest.domain}</h2>
                </div>
                <span className={`px-3.5 py-1 rounded-full text-xs font-extrabold ${
                  selectedRequest.status === 'PENDING'
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                    : selectedRequest.status === 'APPROVED'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                }`}>
                  {selectedRequest.status}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="p-3.5 bg-slate-950/70 rounded-2xl border border-slate-800/80">
                  <div className="text-slate-400 text-[10px] font-bold uppercase tracking-wider mb-1">Child Profile</div>
                  <div className="font-extrabold text-white text-sm">
                    {childrenMap[selectedRequest.childId]?.name || 'Child'}
                  </div>
                </div>

                <div className="p-3.5 bg-slate-950/70 rounded-2xl border border-slate-800/80">
                  <div className="text-slate-400 text-[10px] font-bold uppercase tracking-wider mb-1">Requested At</div>
                  <div className="font-extrabold text-white text-sm">
                    {new Date(selectedRequest.createdAt || selectedRequest.requestedAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>

              {selectedRequest.reason && (
                <div className="p-4 bg-slate-950/80 rounded-2xl border border-slate-800/80 space-y-1">
                  <div className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400">Child's Explanation</div>
                  <div className="text-sm text-slate-200 italic font-medium">"{selectedRequest.reason}"</div>
                </div>
              )}

              {selectedRequest.status === 'PENDING' ? (
                <div className="space-y-3 pt-2">
                  <div className="text-xs font-bold uppercase text-slate-400">Choose Grant Duration</div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <button
                      onClick={() => handleResolve(selectedRequest.id, 'APPROVE', '15m')}
                      disabled={resolvingId === selectedRequest.id}
                      className="p-3.5 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 font-extrabold text-xs rounded-2xl transition shadow-sm cursor-pointer"
                    >
                      ⏱️ 15 Minutes
                    </button>
                    <button
                      onClick={() => handleResolve(selectedRequest.id, 'APPROVE', '1h')}
                      disabled={resolvingId === selectedRequest.id}
                      className="p-3.5 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 font-extrabold text-xs rounded-2xl transition shadow-sm cursor-pointer"
                    >
                      ⌛ 1 Hour
                    </button>
                    <button
                      onClick={() => handleResolve(selectedRequest.id, 'APPROVE', 'today')}
                      disabled={resolvingId === selectedRequest.id}
                      className="p-3.5 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 font-extrabold text-xs rounded-2xl transition shadow-sm cursor-pointer"
                    >
                      📅 Until Bedtime
                    </button>
                    <button
                      onClick={() => handleResolve(selectedRequest.id, 'APPROVE', 'always')}
                      disabled={resolvingId === selectedRequest.id}
                      className="p-3.5 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 font-extrabold text-xs rounded-2xl transition shadow-sm cursor-pointer"
                    >
                      ♾️ Always Allow
                    </button>
                  </div>

                  <button
                    onClick={() => handleResolve(selectedRequest.id, 'DENY')}
                    disabled={resolvingId === selectedRequest.id}
                    className="w-full py-3 bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/30 text-rose-300 font-extrabold text-xs rounded-2xl transition mt-2 cursor-pointer"
                  >
                    🚫 Deny Request
                  </button>
                </div>
              ) : (
                <div className="p-4 bg-slate-950/80 rounded-2xl border border-slate-800 text-xs text-slate-400">
                  This request was {selectedRequest.status.toLowerCase()}
                  {selectedRequest.resolvedByName ? ` by ${selectedRequest.resolvedByName}` : ''} on{' '}
                  {new Date(selectedRequest.resolvedAt || selectedRequest.createdAt || selectedRequest.requestedAt || Date.now()).toLocaleString()}.
                </div>
              )}
            </div>
          ) : (
            <div className="p-12 bg-slate-900/60 border border-slate-800/80 rounded-3xl text-center text-slate-500 text-sm">
              Select an access request from the list to review.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
