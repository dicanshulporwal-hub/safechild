import React, { useState, useEffect } from 'react';

interface ReferralModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ReferralModal: React.FC<ReferralModalProps> = ({ isOpen, onClose }) => {
  const [data, setData] = useState<{ referralCode: string; referralLink: string; totalInvited: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const token = localStorage.getItem('safebrowse_token');

  useEffect(() => {
    if (isOpen) {
      fetch('/api/referrals', {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => r.json())
        .then(setData)
        .catch(() => {});
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fadeIn">
      <div className="bg-slate-900 border border-slate-750 rounded-2xl w-full max-w-md shadow-2xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🎁</span>
            <h3 className="text-lg font-bold text-white">Refer Another Family</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
        </div>

        <p className="text-xs text-slate-300">
          Recommend SafeBrowse to friends or other families in your community. They get protected instantly, and both families receive 1 month of SafeBrowse Premium free.
        </p>

        <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 space-y-2">
          <div className="text-[10px] uppercase font-bold text-slate-400">Your Family Referral Link</div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={data?.referralLink || 'https://safebrowse.io/r/SAFE-FAMILY'}
              className="bg-transparent text-xs text-indigo-300 font-mono flex-1 focus:outline-none"
            />
            <button
              onClick={() => {
                if (data?.referralLink) {
                  navigator.clipboard.writeText(data.referralLink);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }
              }}
              className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded transition"
            >
              {copied ? 'Copied! ✓' : 'Copy'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 pt-2">
          <button
            onClick={() => {
              if (data?.referralLink) {
                window.open(`https://wa.me/?text=${encodeURIComponent(`Hey! I protect my kids online with SafeBrowse. Check it out: ${data.referralLink}`)}`, '_blank');
              }
            }}
            className="p-2.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-emerald-300 text-xs font-semibold flex items-center justify-center gap-1.5 transition"
          >
            <span>💬</span>
            <span>WhatsApp</span>
          </button>
          <button
            onClick={() => {
              if (data?.referralLink) {
                window.open(`mailto:?subject=${encodeURIComponent('Safe browsing for kids')}&body=${encodeURIComponent(`Check out SafeBrowse: ${data.referralLink}`)}`);
              }
            }}
            className="p-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition"
          >
            <span>✉️</span>
            <span>Email</span>
          </button>
        </div>
      </div>
    </div>
  );
};
