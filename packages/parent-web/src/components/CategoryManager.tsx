import React from 'react';
import { Policy } from '../api/client';
import { Flame, Dices, Gamepad2, Users, GraduationCap, Tv, ShieldAlert, Check } from 'lucide-react';

interface CategoryManagerProps {
  childName: string;
  policy: Policy | null;
  onUpdateCategory: (category: string, action: 'BLOCK' | 'ALLOW') => void;
}

const CATEGORIES = [
  { id: 'ADULT_CONTENT', label: 'Adult & Explicit Content', icon: Flame, color: 'text-red-500 bg-red-50', defaultBlock: true },
  { id: 'GAMBLING', label: 'Gambling & Betting', icon: Dices, color: 'text-purple-500 bg-purple-50', defaultBlock: true },
  { id: 'GAMING', label: 'Online Games & Streaming', icon: Gamepad2, color: 'text-indigo-500 bg-indigo-50', defaultBlock: false },
  { id: 'SOCIAL_MEDIA', label: 'Social Media Networks', icon: Users, color: 'text-blue-500 bg-blue-50', defaultBlock: false },
  { id: 'ENTERTAINMENT', label: 'Streaming & Video', icon: Tv, color: 'text-amber-500 bg-amber-50', defaultBlock: false },
  { id: 'EDUCATION', label: 'Educational & Research', icon: GraduationCap, color: 'text-emerald-600 bg-emerald-50', defaultBlock: false },
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
    return catId === 'ADULT_CONTENT' || catId === 'GAMBLING';
  };

  return (
    <div className="bg-white rounded-3xl p-6 sm:p-7 shadow-sm border border-slate-200/80">
      <div className="flex items-center justify-between pb-5 border-b border-slate-100">
        <div>
          <h3 className="text-xl font-black text-slate-900 tracking-tight">Smart Categories</h3>
          <p className="text-xs text-slate-500 font-medium mt-0.5">
            1-Click category blocking across all of {childName}'s devices.
          </p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-3.5">
        {CATEGORIES.map((cat) => {
          const Icon = cat.icon;
          const blocked = isCategoryBlocked(cat.id);

          return (
            <div
              key={cat.id}
              className={`p-4 rounded-2xl border transition-all flex items-center justify-between ${
                blocked
                  ? 'bg-red-50/50 border-red-200/80'
                  : 'bg-slate-50 border-slate-100 hover:bg-slate-100/60'
              }`}
            >
              <div className="flex items-center space-x-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold ${cat.color}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-sm font-extrabold text-slate-900">{cat.label}</div>
                  <div className="text-[11px] font-bold text-slate-500">
                    {blocked ? (
                      <span className="text-red-700 font-extrabold flex items-center gap-1">
                        <ShieldAlert className="w-3 h-3" /> Blocked
                      </span>
                    ) : (
                      <span className="text-emerald-700 font-bold flex items-center gap-1">
                        <Check className="w-3 h-3" /> Allowed
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <button
                onClick={() => onUpdateCategory(cat.id, blocked ? 'ALLOW' : 'BLOCK')}
                className={`px-3 py-1.5 rounded-xl text-xs font-black transition-all ${
                  blocked
                    ? 'bg-red-500 hover:bg-red-600 text-white shadow-sm'
                    : 'bg-slate-200 hover:bg-slate-300 text-slate-700'
                }`}
              >
                {blocked ? 'Blocked' : 'Allow'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};
