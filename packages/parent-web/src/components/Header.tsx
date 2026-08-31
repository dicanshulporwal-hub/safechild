import React, { useState } from 'react';
import { Child } from '../api/client';
import { ShieldCheck, Plus, LogOut, User, Activity, MessageSquare, Users, Gift } from 'lucide-react';

interface HeaderProps {
  childrenList: Child[];
  selectedChild: Child | null;
  onSelectChild: (child: Child) => void;
  onAddChild: (name: string, age?: number) => void;
  stats: { todayBlockedCount: number; pendingRequestsCount: number };
  onOpenRequests: () => void;
  onOpenOperations?: () => void;
  onOpenFeedback?: () => void;
  onOpenProfile?: () => void;
  onOpenFamily?: () => void;
  onOpenReferrals?: () => void;
  onLogout: () => void;
  parentEmail?: string;
  notificationsCount?: number;
}

export const Header: React.FC<HeaderProps> = ({
  childrenList,
  selectedChild,
  onSelectChild,
  onAddChild,
  stats,
  onOpenRequests,
  onOpenOperations,
  onOpenFeedback,
  onOpenProfile,
  onOpenFamily,
  onOpenReferrals,
  onLogout,
  parentEmail = 'parent@safebrowse.io',
  notificationsCount = 0,
}) => {
  const [showAddModal, setShowAddModal] = useState(false);
  const [newChildName, setNewChildName] = useState('');
  const [newChildAge, setNewChildAge] = useState('');

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChildName.trim()) return;
    onAddChild(newChildName.trim(), newChildAge ? parseInt(newChildAge) : undefined);
    setNewChildName('');
    setNewChildAge('');
    setShowAddModal(false);
  };

  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        {/* Brand */}
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-600 flex items-center justify-center text-white shadow-md shadow-emerald-600/20">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-extrabold text-xl tracking-tight text-slate-900">SafeBrowse</span>
              <span className="text-xs uppercase tracking-wider font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
                Family
              </span>
            </div>
            <p className="text-xs text-slate-500 font-medium">Multi-Parent & Cross-Device Protection</p>
          </div>
        </div>

        {/* Child Selector Pills */}
        <div className="flex items-center flex-wrap gap-2">
          {childrenList.map((child) => {
            const isSelected = selectedChild?.id === child.id;
            return (
              <button
                key={child.id}
                onClick={() => onSelectChild(child)}
                className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-full text-sm font-semibold transition-all ${
                  isSelected
                    ? 'bg-slate-900 text-white shadow-sm ring-2 ring-slate-900/10'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                }`}
              >
                <span className="text-base">{child.avatar || '🧑'}</span>
                <span>{child.name}</span>
                {isSelected && (
                  <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block animate-pulse"></span>
                )}
              </button>
            );
          })}

          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center space-x-1 px-3 py-1.5 rounded-full text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 border border-dashed border-slate-300 transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Child</span>
          </button>
        </div>

        {/* Action Controls, Family, Profile & Feedback */}
        <div className="flex items-center space-x-2">
          {/* Family Settings Button */}
          {onOpenFamily && (
            <button
              onClick={onOpenFamily}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-800 text-xs font-bold transition-all border border-emerald-200/60"
              title="Manage Co-Parents & Family Settings"
            >
              <Users className="w-3.5 h-3.5 text-emerald-600" />
              <span className="hidden sm:inline">Family</span>
            </button>
          )}

          {/* Refer Family Button */}
          {onOpenReferrals && (
            <button
              onClick={onOpenReferrals}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-xl bg-purple-50 hover:bg-purple-100 text-purple-700 text-xs font-bold transition-all border border-purple-200/60"
              title="Refer another family"
            >
              <Gift className="w-3.5 h-3.5 text-purple-600" />
              <span className="hidden sm:inline">Refer</span>
            </button>
          )}

          {/* Feedback Button */}
          {onOpenFeedback && (
            <button
              onClick={onOpenFeedback}
              className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-bold transition-all border border-slate-200"
              title="Give Beta Feedback / Report False Positive"
            >
              <MessageSquare className="w-3.5 h-3.5 text-slate-500" />
            </button>
          )}

          {/* Operations Button */}
          {onOpenOperations && (
            <button
              onClick={onOpenOperations}
              className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-bold transition-all border border-indigo-200/60"
              title="Open Beta Operations Dashboard"
            >
              <Activity className="w-3.5 h-3.5 text-indigo-600" />
            </button>
          )}

          {stats.pendingRequestsCount > 0 && (
            <button
              onClick={onOpenRequests}
              className="flex items-center space-x-2 bg-amber-500 hover:bg-amber-600 text-white px-3.5 py-1.5 rounded-full text-xs font-bold shadow-md shadow-amber-500/20 animate-bounce"
            >
              <span className="w-2 h-2 rounded-full bg-white"></span>
              <span>{stats.pendingRequestsCount} Request{stats.pendingRequestsCount > 1 ? 's' : ''}</span>
            </button>
          )}

          {/* Parent Profile & Logout */}
          <div className="flex items-center space-x-1.5 bg-slate-50 pl-2.5 pr-1.5 py-1 rounded-xl border border-slate-200">
            <button
              onClick={onOpenProfile}
              className="flex items-center space-x-1.5 text-xs font-semibold text-slate-700 hover:text-emerald-700 transition"
              title="Edit Profile & Security"
            >
              <User className="w-3.5 h-3.5 text-emerald-600" />
              <span className="hidden md:inline max-w-[110px] truncate">{parentEmail}</span>
            </button>

            <button
              onClick={onLogout}
              className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
              title="Sign Out of SafeBrowse"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Add Child Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-100">
            <h3 className="text-lg font-bold text-slate-900 mb-1">Add Child Profile</h3>
            <p className="text-xs text-slate-500 mb-4">
              Create a child profile to manage web policies across all of their devices simultaneously.
            </p>

            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Child's Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Rahul, Maya"
                  value={newChildName}
                  onChange={(e) => setNewChildName(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Age (Optional)
                </label>
                <input
                  type="number"
                  placeholder="e.g. 11"
                  value={newChildAge}
                  onChange={(e) => setNewChildAge(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm"
                />
              </div>

              <div className="flex items-center justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl text-sm font-bold bg-emerald-600 hover:bg-emerald-700 text-white shadow-md shadow-emerald-600/20"
                >
                  Create Child
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </header>
  );
};
