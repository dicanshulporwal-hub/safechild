import React from 'react';
import { Policy } from '../api/client';
import {
  Flame,
  Dices,
  Gamepad2,
  Users,
  GraduationCap,
  Tv,
  ShieldAlert,
  Check,
  Bot,
  Skull,
  ShieldCheck,
  Layers,
} from 'lucide-react';

interface CategoryManagerProps {
  childName: string;
  policy: Policy | null;
  onUpdateCategory: (category: string, action: 'BLOCK' | 'ALLOW') => void;
}

const CATEGORIES = [
  {
    id: 'ADULT_CONTENT',
    label: 'Adult & Explicit Content',
    desc: 'Pornography, adult dating, mature interactions',
    icon: Flame,
    color: 'text-rose-400 bg-rose-500/10 border-rose-500/30',
    defaultBlock: true,
  },
  {
    id: 'AI_TOOLS',
    label: 'AI Chatbots & Cheating Tools',
    desc: 'ChatGPT, Claude, Character.ai, DeepSeek, Poe',
    icon: Bot,
    color: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
    defaultBlock: false,
  },
  {
    id: 'SOCIAL_MEDIA',
    label: 'Social Media & Short Video',
    desc: 'TikTok, Instagram, Snapchat, Reddit, Discord, X',
    icon: Users,
    color: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
    defaultBlock: false,
  },
  {
    id: 'GAMING',
    label: 'Online Games & Virtual Worlds',
    desc: 'Roblox, Steam, Epic Games, Twitch, Minecraft',
    icon: Gamepad2,
    color: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/30',
    defaultBlock: false,
  },
  {
    id: 'GAMBLING',
    label: 'Gambling & Crypto Betting',
    desc: 'Casinos, sportsbooks, loot boxes, Stake, Bet365',
    icon: Dices,
    color: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
    defaultBlock: true,
  },
  {
    id: 'PIRACY',
    label: 'Piracy & Torrent Portals',
    desc: 'ThePirateBay, 1337x, illegal streaming, magnet links',
    icon: Skull,
    color: 'text-orange-400 bg-orange-500/10 border-orange-500/30',
    defaultBlock: true,
  },
  {
    id: 'MALWARE_SECURITY',
    label: 'Malware & Phishing Scams',
    desc: 'Known deceptive URLs, cryptojackers, botnets',
    icon: ShieldAlert,
    color: 'text-red-400 bg-red-500/10 border-red-500/30',
    defaultBlock: true,
  },
  {
    id: 'ENTERTAINMENT',
    label: 'Streaming & Entertainment',
    desc: 'Netflix, Disney+, Hulu, Spotify, Crunchyroll',
    icon: Tv,
    color: 'text-violet-400 bg-violet-500/10 border-violet-500/30',
    defaultBlock: false,
  },
  {
    id: 'EDUCATION',
    label: 'Educational & Homework',
    desc: 'Wikipedia, Khan Academy, Duolingo, Coursera',
    icon: GraduationCap,
    color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
    defaultBlock: false,
  },
];

export const CategoryManager: React.FC<CategoryManagerProps> = ({
  childName,
  policy,
  onUpdateCategory,
}) => {
  const categoryControls = (policy as any)?.categoryControls || [];

  const isCategoryBlocked = (catId: string) => {
    const found = categoryControls.find((c: any) => c.category === catId);
    if (found) return found.action === 'BLOCK';
    const def = CATEGORIES.find((c) => c.id === catId);
    return def ? def.defaultBlock : false;
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800/90 rounded-3xl p-6 sm:p-8 shadow-2xl backdrop-blur-xl space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-800/80">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-purple-500/20 to-pink-500/20 border border-purple-500/30 text-purple-400 flex items-center justify-center shadow-inner">
            <Layers className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-extrabold text-white tracking-tight">Smart Content Categories</h2>
            <p className="text-xs text-slate-400">DNS filter blocks millions of matching domains with zero latency.</p>
          </div>
        </div>
        <span className="text-xs font-semibold px-3 py-1 bg-slate-950/80 text-emerald-400 rounded-full border border-slate-800 self-start sm:self-auto">
          Active for {childName}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-1">
        {CATEGORIES.map((cat) => {
          const Icon = cat.icon;
          const blocked = isCategoryBlocked(cat.id);

          return (
            <div
              key={cat.id}
              className={`p-5 rounded-2xl border transition-all duration-200 flex flex-col justify-between space-y-4 ${
                blocked
                  ? 'bg-rose-950/20 border-rose-500/40 shadow-lg shadow-rose-950/10'
                  : 'bg-slate-950/60 border-slate-800/80 hover:border-slate-700/80 hover:bg-slate-950/90'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-2xl border flex items-center justify-center shrink-0 shadow-sm ${cat.color}`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-xs font-extrabold text-white leading-tight">{cat.label}</div>
                    <div className="text-[11px] text-slate-400 mt-1 leading-relaxed line-clamp-2">{cat.desc}</div>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between pt-3 border-t border-slate-800/60">
                <span className={`text-[10px] font-extrabold uppercase tracking-wider flex items-center gap-1.5 ${
                  blocked ? 'text-rose-400' : 'text-emerald-400'
                }`}>
                  {blocked ? (
                    <>
                      <ShieldAlert className="w-3.5 h-3.5" />
                      <span>BLOCKED</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span>ALLOWED</span>
                    </>
                  )}
                </span>

                {/* Luxury Smooth Toggle Switch */}
                <button
                  type="button"
                  onClick={() => onUpdateCategory(cat.id, blocked ? 'ALLOW' : 'BLOCK')}
                  className={`w-12 h-6 flex items-center rounded-full p-1 transition-all duration-300 cursor-pointer shadow-inner ${
                    blocked ? 'bg-rose-600 justify-end' : 'bg-slate-800 justify-start'
                  }`}
                  title={blocked ? 'Click to unblock' : 'Click to block'}
                >
                  <div className="bg-white w-4 h-4 rounded-full shadow-md transform transition-transform" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
