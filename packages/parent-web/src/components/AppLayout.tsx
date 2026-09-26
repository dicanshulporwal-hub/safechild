import React, { useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { api, Child, Stats } from '../api/client';
import {
  ShieldCheck,
  Users,
  MessageSquare,
  Gift,
  Activity,
  User,
  Lock,
  LogOut,
  Plus,
  Radio,
  Clock,
  Settings,
  Download,
  Laptop,
} from 'lucide-react';
import { NotificationCenter } from './NotificationCenter';
import { useToast } from './Toast';
import { AiHelpBot } from './AiHelpBot';

interface AppLayoutProps {
  childrenList: Child[];
  selectedChild: Child | null;
  onSelectChild: (child: Child) => void;
  onAddChild: (name: string, age?: number) => void;
  stats: Stats;
  parentEmail: string;
  onLogout: () => void;
  children: React.ReactNode;
}

export const AppLayout: React.FC<AppLayoutProps> = ({
  childrenList,
  selectedChild,
  onSelectChild,
  onAddChild,
  stats,
  parentEmail,
  onLogout,
  children,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { showToast } = useToast();
  const [showAddChildModal, setShowAddChildModal] = useState(false);
  const [isFamilyPaused, setIsFamilyPaused] = useState(false);
  const [childName, setChildName] = useState('');
  const [childAge, setChildAge] = useState('');

  const isSystemAdmin = api.getUserRole() === 'SYSTEM_ADMIN';

  const handleCreateChild = (e: React.FormEvent) => {
    e.preventDefault();
    if (!childName.trim()) return;
    onAddChild(childName.trim(), childAge ? parseInt(childAge) : undefined);
    setChildName('');
    setChildAge('');
    setShowAddChildModal(false);
  };

  const navItems = [
    {
      to: selectedChild ? `/children/${selectedChild.id}` : '/dashboard',
      label: 'Child Protection',
      icon: ShieldCheck,
      badge: undefined,
    },
    {
      to: '/requests',
      label: 'Ask Parent',
      icon: MessageSquare,
      badge: stats.pendingRequestsCount > 0 ? stats.pendingRequestsCount : undefined,
    },
    {
      to: '/family',
      label: 'Family & Co-Parents',
      icon: Users,
      badge: undefined,
    },
    {
      to: '/settings/profile',
      label: 'Parent Profile',
      icon: User,
      badge: undefined,
    },
    {
      to: '/settings/security',
      label: 'Security & Sessions',
      icon: Lock,
      badge: undefined,
    },
    {
      to: '/referrals',
      label: 'Refer a Family',
      icon: Gift,
      badge: undefined,
    },
    ...(isSystemAdmin
      ? [
          {
            to: '/admin',
            label: 'Admin Console',
            icon: Activity,
            badge: undefined,
          },
        ]
      : []),
    {
      to: '/status',
      label: 'System Status',
      icon: Radio,
      badge: undefined,
    },
    {
      to: '/feedback',
      label: 'Feedback',
      icon: Clock,
      badge: undefined,
    },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col antialiased selection:bg-emerald-500/30 selection:text-emerald-200">
      {/* Top Header */}
      <header className="bg-slate-900/80 border-b border-slate-800/80 sticky top-0 z-40 backdrop-blur-xl shadow-lg shadow-black/20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex items-center justify-between gap-4">
          {/* Logo & Brand */}
          <div
            className="flex items-center gap-3 cursor-pointer group"
            onClick={() => navigate(selectedChild ? `/children/${selectedChild.id}` : '/dashboard')}
          >
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-emerald-500/25 group-hover:scale-105 transition-transform duration-200">
              <ShieldCheck className="w-5 h-5 text-slate-950 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-lg text-white tracking-tight group-hover:text-emerald-300 transition-colors">
                  SafeBrowse
                </span>
                <span className="text-[10px] uppercase tracking-wider font-extrabold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-full shadow-sm">
                  Family Guard
                </span>
              </div>
            </div>
          </div>

          {/* Child Switcher Pills */}
          <div className="hidden md:flex items-center gap-2 p-1 bg-slate-950/70 border border-slate-800/80 rounded-2xl">
            {childrenList.map((child) => {
              const isSelected = selectedChild?.id === child.id;
              return (
                <button
                  key={child.id}
                  onClick={() => {
                    onSelectChild(child);
                    navigate(`/children/${child.id}`);
                  }}
                  className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all duration-200 ${
                    isSelected
                      ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-slate-950 shadow-md shadow-emerald-500/25 scale-[1.02]'
                      : 'text-slate-400 hover:text-white hover:bg-slate-900'
                  }`}
                >
                  <span className="text-sm">{child.avatar || '🧑'}</span>
                  <span>{child.name}</span>
                  {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-slate-950 animate-pulse" />}
                </button>
              );
            })}

            <button
              onClick={() => setShowAddChildModal(true)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold text-slate-400 hover:text-emerald-300 hover:bg-slate-900 border border-dashed border-slate-700/80 transition-all duration-200"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Child</span>
            </button>
          </div>

          {/* User Profile & Sign Out */}
          <div className="flex items-center gap-2.5">
            {/* 1-Tap Dinner Time / Global Family Pause Button */}
            <button
              onClick={async () => {
                const nextState = !isFamilyPaused;
                try {
                  const res = await api.pauseFamilyAll(nextState);
                  setIsFamilyPaused(nextState);
                  showToast(
                    nextState
                      ? '🍽️ Dinner Time Active: Internet paused across all family devices!'
                      : '🟢 Family Internet Resumed: All devices unpaused.',
                    nextState ? 'info' : 'success'
                  );
                } catch (e: any) {
                  showToast(e.message || 'Failed to toggle family pause', 'error');
                }
              }}
              title={isFamilyPaused ? "Click to resume family internet" : "Pause all children's devices for family time"}
              className={`hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-extrabold transition-all duration-200 cursor-pointer shadow-sm active:scale-95 ${
                isFamilyPaused
                  ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40 hover:bg-rose-500/30'
                  : 'bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 hover:border-amber-500/50'
              }`}
            >
              <span className="text-sm">{isFamilyPaused ? '⏸️' : '🍽️'}</span>
              <span>{isFamilyPaused ? 'Family Paused' : 'Dinner Time'}</span>
            </button>

            <NotificationCenter />

            {stats.pendingRequestsCount > 0 && (
              <button
                onClick={() => navigate('/requests')}
                className="flex items-center gap-1.5 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-slate-950 px-3 py-1.5 rounded-xl text-xs font-extrabold shadow-md shadow-amber-500/25 animate-pulse transition"
              >
                <span>📨</span>
                <span>{stats.pendingRequestsCount} Pending</span>
              </button>
            )}

            <div className="flex items-center gap-2 pl-2.5 border-l border-slate-800">
              <button
                onClick={() => navigate('/settings/profile')}
                className="flex items-center gap-2 text-xs font-semibold text-slate-300 hover:text-emerald-400 transition group"
              >
                <div className="w-8 h-8 rounded-xl bg-slate-800 border border-slate-700/80 flex items-center justify-center text-xs font-bold text-white group-hover:border-emerald-500/50 shadow-inner transition-colors">
                  {parentEmail ? parentEmail.charAt(0).toUpperCase() : 'P'}
                </div>
                <span className="hidden lg:inline max-w-[120px] truncate">{parentEmail}</span>
              </button>

              <button
                onClick={onLogout}
                className="p-2 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-xl transition-all"
                title="Sign Out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main App Body with Sidebar Layout */}
      <div className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col md:flex-row gap-6">
        {/* Left Sidebar Navigation (Desktop) */}
        <aside className="w-full md:w-64 shrink-0 space-y-1">
          <div className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500 px-3.5 pb-2">
            Family Command Center
          </div>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center justify-between px-3.5 py-2.5 rounded-2xl text-xs font-bold transition-all duration-200 ${
                  isActive
                    ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 shadow-sm shadow-emerald-500/5'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/80 border border-transparent'
                }`
              }
            >
              <div className="flex items-center gap-2.5">
                <item.icon className="w-4 h-4" />
                <span>{item.label}</span>
              </div>
              {item.badge !== undefined && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-gradient-to-r from-amber-500 to-orange-500 text-slate-950 font-mono shadow-sm">
                  {item.badge}
                </span>
              )}
            </NavLink>
          ))}

          {/* Quick Child App Download (Windows MSI) */}
          <div className="pt-4 mt-4 border-t border-slate-800/80 px-1">
            <div className="p-3 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-2">
              <div className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Download className="w-3 h-3 text-indigo-400" />
                <span>Windows Child Protection</span>
              </div>
              <p className="text-[10px] text-slate-400 leading-tight">
                Install on child's Windows device to enforce protection.
              </p>
              <div className="pt-1">
                <a
                  href="/api/downloads/windows"
                  download="SafeBrowseChild-Pilot.msi"
                  className="flex items-center justify-between py-2 px-3 rounded-xl bg-indigo-950/40 hover:bg-indigo-900/40 border border-indigo-500/30 text-indigo-300 text-[11px] font-bold transition cursor-pointer"
                  title="Download SafeBrowse Windows Installer (MSI)"
                >
                  <div className="flex items-center gap-2">
                    <Laptop className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Download Installer (.msi)</span>
                  </div>
                  <Download className="w-3 h-3 text-indigo-400" />
                </a>
              </div>
            </div>
          </div>
        </aside>

        {/* Routed Content Area */}
        <main className="flex-1 min-w-0">
          {children}
        </main>
      </div>

      {/* Add Child Confirmation Modal */}
      {showAddChildModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-800 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-white">Add Child Profile</h3>
              <button onClick={() => setShowAddChildModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>
            <p className="text-xs text-slate-400">
              Create a child profile to manage web policies across all of their devices simultaneously.
            </p>

            <form onSubmit={handleCreateChild} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase mb-1">Child's Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Rahul, Maya"
                  value={childName}
                  onChange={(e) => setChildName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase mb-1">Age (Optional)</label>
                <input
                  type="number"
                  placeholder="e.g. 11"
                  value={childAge}
                  onChange={(e) => setChildAge(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddChildModal(false)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-600/20"
                >
                  Create Child
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Floating AI Assistant for Help & Guidance */}
      <AiHelpBot />
    </div>
  );
};
