import React, { useState, useEffect } from 'react';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import { Gift, Copy, Share2, Mail } from 'lucide-react';

export const ReferralPage: React.FC = () => {
  const { showToast } = useToast();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getReferrals()
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const referralLink = data?.referralLink || 'https://safebrowse.io/r/SAFE-FAMILY';

  const copyToClipboard = () => {
    navigator.clipboard.writeText(referralLink);
    showToast('Referral link copied to clipboard!', 'success');
  };

  const shareWhatsApp = () => {
    const text = encodeURIComponent(`Protect your family with SafeBrowse! Use my invite link: ${referralLink}`);
    window.open(`https://api.whatsapp.com/send?text=${text}`, '_blank');
  };

  const shareEmail = () => {
    const subject = encodeURIComponent('Try SafeBrowse Family Web Protection');
    const body = encodeURIComponent(`Hi!\n\nI use SafeBrowse to protect our family's devices. You can sign up with my invite link here:\n${referralLink}`);
    window.open(`mailto:?subject=${subject}&body=${body}`, '_blank');
  };

  if (loading) {
    return <div className="p-8 text-center text-slate-400">Loading referral program...</div>;
  }

  return (
    <div className="max-w-3xl space-y-6 animate-fadeIn">
      <div>
        <h1 className="text-2xl font-extrabold text-white tracking-tight">Refer Other Families</h1>
        <p className="text-xs text-slate-400">Share SafeBrowse with friends and families to unlock community beta perks</p>
      </div>

      <div className="bg-slate-900 border border-purple-500/30 rounded-2xl p-6 shadow-xl space-y-6">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-400 text-3xl">
            🎁
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Give Protection. Get 1 Month Free.</h2>
            <p className="text-xs text-slate-400 mt-0.5">When a family signs up using your link, both families receive 1 month of Beta Pro.</p>
          </div>
        </div>

        <div className="p-4 bg-slate-950 rounded-xl border border-slate-800 space-y-2">
          <label className="block text-[11px] font-bold uppercase text-slate-400">Your Unique Referral Link</label>
          <div className="flex gap-2">
            <input
              type="text"
              readOnly
              value={referralLink}
              className="bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-purple-300 font-mono flex-1 select-all"
            />
            <button
              onClick={copyToClipboard}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>Copy</span>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            onClick={shareWhatsApp}
            className="flex-1 min-w-[140px] py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition flex items-center justify-center gap-2 shadow"
          >
            <Share2 className="w-3.5 h-3.5" />
            <span>Share via WhatsApp</span>
          </button>
          <button
            onClick={shareEmail}
            className="flex-1 min-w-[140px] py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-bold transition flex items-center justify-center gap-2 border border-slate-700"
          >
            <Mail className="w-3.5 h-3.5" />
            <span>Share via Email</span>
          </button>
        </div>
      </div>
    </div>
  );
};
