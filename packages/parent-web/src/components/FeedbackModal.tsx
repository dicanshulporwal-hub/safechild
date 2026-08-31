import React, { useState } from 'react';
import { X, MessageSquare, Send, CheckCircle2, AlertCircle } from 'lucide-react';

interface FeedbackModalProps {
  onClose: () => void;
  defaultCategory?: string;
  defaultDomain?: string;
}

export const FeedbackModal: React.FC<FeedbackModalProps> = ({
  onClose,
  defaultCategory = 'WEBSITE_WRONGLY_BLOCKED',
  defaultDomain = '',
}) => {
  const [category, setCategory] = useState(defaultCategory);
  const [domain, setDomain] = useState(defaultDomain);
  const [notes, setNotes] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      if (category === 'WEBSITE_WRONGLY_BLOCKED' && domain.trim()) {
        await fetch('/api/feedback/false-positive', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('sb_auth_token') || ''}`,
          },
          body: JSON.stringify({
            childId: 'child-rahul-1',
            domain: domain.trim(),
            notes: notes.trim(),
          }),
        });
      } else {
        await fetch('/api/feedback', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('sb_auth_token') || ''}`,
          },
          body: JSON.stringify({
            category,
            notes: domain ? `Domain: ${domain}\n${notes}` : notes,
          }),
        });
      }

      setSubmitted(true);
    } catch (e) {
      console.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn">
      <div className="bg-white rounded-3xl max-w-lg w-full p-6 sm:p-7 shadow-2xl border border-slate-200">
        <div className="flex items-center justify-between pb-4 border-b border-slate-100">
          <div className="flex items-center space-x-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center">
              <MessageSquare className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-black text-slate-900">Beta Feedback & Support</h3>
              <p className="text-xs text-slate-500 font-medium">Help us improve SafeBrowse for your family</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {submitted ? (
          <div className="py-8 text-center space-y-3">
            <CheckCircle2 className="w-12 h-12 text-emerald-600 mx-auto" />
            <h4 className="text-base font-black text-slate-900">Thank You for Your Feedback!</h4>
            <p className="text-xs text-slate-600 max-w-xs mx-auto">
              Our engineering team has received your report and will review rule classifications immediately.
            </p>
            <button
              onClick={onClose}
              className="mt-4 px-6 py-2 rounded-xl bg-slate-900 text-white text-xs font-bold"
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <div>
              <label className="text-xs font-bold text-slate-700 block mb-1">Feedback Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <option value="WEBSITE_WRONGLY_BLOCKED">Website wrongly blocked (False Positive)</option>
                <option value="WEBSITE_SHOULD_HAVE_BEEN_BLOCKED">Website should have been blocked (Missed Block)</option>
                <option value="PROTECTION_STOPPED">Protection stopped / VPN disconnected</option>
                <option value="INTERNET_STOPPED_WORKING">Internet stopped working</option>
                <option value="INSTALLATION_PROBLEM">Installation or pairing problem</option>
                <option value="ASK_PARENT_PROBLEM">Ask Parent workflow problem</option>
                <option value="DASHBOARD_CONFUSING">Dashboard confusing or hard to use</option>
                <option value="OTHER">Other feedback or suggestion</option>
              </select>
            </div>

            {(category === 'WEBSITE_WRONGLY_BLOCKED' || category === 'WEBSITE_SHOULD_HAVE_BEEN_BLOCKED') && (
              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">Website Domain or URL</label>
                <input
                  type="text"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="e.g. schoolportal.edu, khanacademy.org"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            )}

            <div>
              <label className="text-xs font-bold text-slate-700 block mb-1">Additional Notes (Optional)</label>
              <textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Describe what happened or what website was affected..."
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center space-x-1.5 shadow-md shadow-emerald-600/20"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{submitting ? 'Submitting...' : 'Send Feedback'}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
