import React, { useState } from 'react';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import { Send, CheckCircle } from 'lucide-react';

export const FeedbackPage: React.FC = () => {
  const { showToast } = useToast();
  const [feedbackType, setFeedbackType] = useState<'FALSE_POSITIVE' | 'BUG' | 'FEATURE' | 'GENERAL'>('FALSE_POSITIVE');
  const [domain, setDomain] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.submitFeedback({
        type: feedbackType,
        domain: feedbackType === 'FALSE_POSITIVE' ? domain : undefined,
        message,
      });
      setSubmitted(true);
      showToast('Thank you! Feedback submitted directly to our engineering team.', 'success');
    } catch (e: any) {
      showToast(e.message || 'Failed to submit feedback', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6 animate-fadeIn">
      <div>
        <h1 className="text-2xl font-extrabold text-white tracking-tight">Beta Feedback & False Positive Report</h1>
        <p className="text-xs text-slate-400">Help us improve categorization accuracy and platform stability</p>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-5">
        {submitted ? (
          <div className="p-8 text-center space-y-3">
            <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto" />
            <h3 className="text-lg font-bold text-white">Report Received!</h3>
            <p className="text-xs text-slate-400">
              Our safety classification team has received your report and will verify the domain categorization.
            </p>
            <button
              onClick={() => {
                setSubmitted(false);
                setDomain('');
                setMessage('');
              }}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold rounded-xl"
            >
              Submit Another Report
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase mb-1">Feedback Category</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { id: 'FALSE_POSITIVE', label: 'False Positive (Legit Site Blocked)' },
                  { id: 'BUG', label: 'Bug / Technical Issue' },
                  { id: 'FEATURE', label: 'Feature Request' },
                  { id: 'GENERAL', label: 'General Feedback' },
                ].map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setFeedbackType(cat.id as any)}
                    className={`p-3 rounded-xl border text-left text-xs font-semibold transition ${
                      feedbackType === cat.id
                        ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                        : 'bg-slate-950/40 border-slate-800 text-slate-400'
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
            </div>

            {feedbackType === 'FALSE_POSITIVE' && (
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase mb-1">Blocked Website Domain</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. schoolportal.edu, khanacademy.org"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-xs font-mono focus:outline-none focus:border-emerald-500"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase mb-1">Details & Description</label>
              <textarea
                required
                rows={4}
                placeholder="Please describe what happened..."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-white text-xs focus:outline-none focus:border-emerald-500"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-emerald-600/20 flex items-center gap-2 disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{submitting ? 'Submitting...' : 'Submit Report'}</span>
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
