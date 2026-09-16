import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ShieldAlert,
  Lock,
  Clock,
  Send,
  CheckCircle2,
  ArrowRight,
  BookOpen,
  Sparkles,
  HeartHandshake,
  ExternalLink,
  MessageCircle,
  HelpCircle,
  Compass,
} from 'lucide-react';

export const BlockPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const domain = searchParams.get('domain') || 'tiktok.com';
  const reason = searchParams.get('reason') || 'Social Media & Short Video Filter';
  const childName = searchParams.get('child') || 'Alex';

  const [showRequestForm, setShowRequestForm] = useState(false);
  const [requestReason, setRequestReason] = useState('');
  const [duration, setDuration] = useState('15');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const quickReasons = [
    '📚 Needed for school / homework project',
    '💬 Communicating with classmates',
    '✨ Finished all homework and chores',
    '🔍 Need to look up reference info',
  ];

  const suggestedSites = [
    { name: 'Khan Academy', domain: 'khanacademy.org', icon: '🎓', desc: 'Free math, science & art lessons' },
    { name: 'Google Classroom', domain: 'classroom.google.com', icon: '📝', desc: 'School assignments & classes' },
    { name: 'National Geographic Kids', domain: 'natgeokids.com', icon: '🦁', desc: 'Animals, science & geography' },
    { name: 'Duolingo', domain: 'duolingo.com', icon: '🦉', desc: 'Learn languages interactively' },
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!requestReason.trim()) return;
    setSubmitting(true);
    try {
      const token = localStorage.getItem('sb_auth_token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      await fetch('/api/notifications/test-alert', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'REQUEST',
          domain,
          reason: `${requestReason.trim()} (${duration} mins requested)`,
        }),
      });
      setSubmitted(true);
    } catch (err) {
      console.error(err);
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-between p-4 sm:p-8 relative overflow-hidden font-sans selection:bg-rose-500/30 selection:text-rose-200">
      {/* Ambient background glow effects */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-rose-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-10 right-10 w-72 h-72 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />

      {/* Top Header Bar */}
      <header className="w-full max-w-4xl flex items-center justify-between z-10">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-rose-500 to-amber-500 flex items-center justify-center shadow-lg shadow-rose-500/20 text-white font-bold">
            <ShieldAlert className="w-5 h-5" />
          </div>
          <div>
            <span className="font-extrabold text-base tracking-tight text-white block">SafeBrowse</span>
            <span className="text-[10px] text-slate-400 font-medium">Family Digital Safety Engine</span>
          </div>
        </div>

        <div className="px-3 py-1 bg-slate-900/80 border border-slate-800 rounded-full text-xs text-slate-400 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span>Device Protected</span>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="w-full max-w-2xl my-8 z-10 space-y-6">
        {/* Hero Card */}
        <div className="bg-slate-900/80 border border-slate-800/80 backdrop-blur-xl rounded-3xl p-6 sm:p-10 shadow-2xl space-y-6 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-rose-500 via-amber-500 to-rose-500" />

          {/* Block Status Icon & Heading */}
          <div className="text-center space-y-3 pt-2">
            <div className="w-20 h-20 rounded-3xl bg-rose-500/10 border border-rose-500/30 text-rose-400 flex items-center justify-center mx-auto shadow-inner ring-8 ring-rose-500/5">
              <Lock className="w-10 h-10 stroke-[2.2]" />
            </div>

            <div className="space-y-1.5">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider text-rose-400 bg-rose-500/10 px-3.5 py-1 rounded-full border border-rose-500/20">
                🔒 SafeGuard Active
              </span>

              {/* Explicit User Message */}
              <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                This website has been blocked by your parent
              </h1>

              <p className="text-xs sm:text-sm text-slate-400 max-w-md mx-auto leading-relaxed">
                Access to <span className="text-white font-mono font-bold px-2 py-0.5 bg-slate-950/80 rounded border border-slate-800 inline-block mt-1">{domain}</span> is currently restricted under your family safety schedule.
              </p>
            </div>
          </div>

          {/* Reason Badge */}
          <div className="p-4 bg-slate-950/70 border border-slate-800/80 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-3 text-center sm:text-left">
              <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 shrink-0">
                <Sparkles className="w-4 h-4" />
              </div>
              <div>
                <div className="font-bold text-white">Rule Protection Reason</div>
                <div className="text-[11px] text-slate-400 mt-0.5">{reason}</div>
              </div>
            </div>

            <span className="px-3 py-1 bg-slate-800/80 text-slate-300 rounded-lg text-[11px] font-mono border border-slate-700/50 shrink-0">
              Policy v1.1
            </span>
          </div>

          {/* Call to Action: "To get access click here" */}
          {!showRequestForm && !submitted && (
            <div className="pt-2 text-center space-y-3">
              <button
                onClick={() => setShowRequestForm(true)}
                className="w-full sm:w-auto px-8 py-4 bg-gradient-to-r from-cyan-500 via-blue-600 to-indigo-600 hover:from-cyan-400 hover:via-blue-500 hover:to-indigo-500 text-white rounded-2xl text-sm font-extrabold transition-all shadow-xl shadow-cyan-500/25 hover:shadow-cyan-500/40 hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2.5 mx-auto group cursor-pointer"
              >
                <span>To get access, click here</span>
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </button>

              <p className="text-[11px] text-slate-500">
                Send an instant unlock request with your reason directly to Mom & Dad.
              </p>
            </div>
          )}

          {/* Interactive Request Form (Revealed when clicked) */}
          {showRequestForm && !submitted && (
            <div className="p-6 bg-slate-950/80 border border-cyan-500/30 rounded-2xl space-y-5 animate-in fade-in slide-in-from-top-4 duration-300">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div className="flex items-center gap-2 text-cyan-400">
                  <MessageCircle className="w-4 h-4" />
                  <h3 className="text-sm font-bold text-white">Ask Mom & Dad for Access</h3>
                </div>
                <button
                  onClick={() => setShowRequestForm(false)}
                  className="text-xs text-slate-500 hover:text-slate-300 transition"
                >
                  Cancel
                </button>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Quick reason buttons */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-300">
                    Why do you need access? (Pick or type)
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {quickReasons.map((qr) => (
                      <button
                        key={qr}
                        type="button"
                        onClick={() => setRequestReason(qr)}
                        className={`p-2.5 rounded-xl text-left text-xs border transition ${
                          requestReason === qr
                            ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-300'
                            : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        {qr}
                      </button>
                    ))}
                  </div>

                  <textarea
                    required
                    rows={2}
                    placeholder="Or type a custom note to Mom & Dad..."
                    value={requestReason}
                    onChange={(e) => setRequestReason(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl p-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 resize-none mt-2"
                  />
                </div>

                {/* Duration Selection */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-300 flex items-center justify-between">
                    <span>How much time do you need?</span>
                    <span className="text-[10px] text-cyan-400 font-mono">Temporary Grant</span>
                  </label>
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { label: '15 mins', val: '15' },
                      { label: '30 mins', val: '30' },
                      { label: '1 hour', val: '60' },
                      { label: 'Today', val: '1440' },
                    ].map((item) => (
                      <button
                        key={item.val}
                        type="button"
                        onClick={() => setDuration(item.val)}
                        className={`py-2 rounded-xl text-xs font-bold border transition ${
                          duration === item.val
                            ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-300 shadow-sm'
                            : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Submit button */}
                <button
                  type="submit"
                  disabled={submitting || !requestReason.trim()}
                  className="w-full py-3.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-cyan-500/25 flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
                >
                  {submitting ? (
                    <span>Sending Notification to Parents...</span>
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      <span>Send Request to Mom & Dad</span>
                    </>
                  )}
                </button>
              </form>
            </div>
          )}

          {/* Success / Request Sent State */}
          {submitted && (
            <div className="p-6 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl text-center space-y-3 animate-in fade-in duration-300">
              <div className="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto ring-4 ring-emerald-500/10">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Unlock Request Delivered!</h3>
                <p className="text-xs text-slate-300 mt-1 max-w-sm mx-auto leading-relaxed">
                  Mom & Dad have received a notification on their device. As soon as they tap <strong>Approve</strong>, this page will unlock.
                </p>
              </div>
              <div className="inline-flex items-center gap-2 px-3 py-1 bg-emerald-500/20 text-emerald-300 rounded-full text-[11px] font-semibold border border-emerald-500/30">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                <span>Waiting for parent response...</span>
              </div>
            </div>
          )}
        </div>

        {/* Helpful Educational Alternatives Card */}
        <div className="bg-slate-900/60 border border-slate-800/80 rounded-3xl p-6 backdrop-blur-md space-y-4">
          <div className="flex items-center gap-2 text-slate-300 text-xs font-bold uppercase tracking-wider">
            <Compass className="w-4 h-4 text-cyan-400" />
            <span>Recommended Learning & Study Sites</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {suggestedSites.map((site) => (
              <a
                key={site.domain}
                href={`https://${site.domain}`}
                target="_blank"
                rel="noreferrer"
                className="p-3 bg-slate-950/60 hover:bg-slate-950 border border-slate-800/80 hover:border-slate-700 rounded-xl transition flex items-center gap-3 group"
              >
                <span className="text-2xl">{site.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-white flex items-center gap-1 group-hover:text-cyan-400 transition-colors">
                    <span>{site.name}</span>
                    <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                  <div className="text-[10px] text-slate-400 truncate">{site.desc}</div>
                </div>
              </a>
            ))}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full max-w-4xl text-center py-4 text-[11px] text-slate-500 z-10 border-t border-slate-900/80">
        SafeBrowse Cross-Device Protection Engine • Protecting what matters most
      </footer>
    </div>
  );
};