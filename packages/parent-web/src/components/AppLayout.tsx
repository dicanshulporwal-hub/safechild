import React, { useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { Child, Stats } from '../api/client';
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
} from 'lucide-react';

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
  const [showAddChildModal, setShowAddChildModal] = useState(false);
  const [childName, setChildName] = useState('');
  const [childAge, setChildAge] = useState('');

  const [isSystemAdmin, setIsSystemAdmin] = useState(false);

  React.useEffect(() => {
    import('../api/client').then(({ api }) => {
      api.getProfile?.().then((p: any) => {
        if (p?.systemRole === 'SYSTEM_ADMIN') {
          setIsSystemAdmin(true);
        }
      }).catch(() => {});
    });
  }, []);

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
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col antialiased">
      {/* Top Header */}
      <header className="bg-slate-900/90 border-b border-slate-800 sticky top-0 z-30 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between gap-4">
          {/* Logo & Brand */}
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => navigate(selectedChild ? `/children/${selectedChild.id}` : '/dashboard')}>
            <div className="w-9 h-9 rounded-xl bg-emerald-500 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-emerald-500/20">
              <ShieldCheck className="w-5 h-5 text-slate-950" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-lg text-white tracking-tight">SafeBrowse</span>
                <span className="text-[10px] uppercase tracking-wider font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                  Family
                </span>
              </div>
            </div>
          </div>

          {/* Child Switcher Pills */}
          <div className="hidden md:flex items-center gap-2">
            {childrenList.map((child) => {
              const isSelected = selectedChild?.id === child.id;
              return (
                <button
                  key={child.id}
                  onClick={() => {
                    onSelectChild(child);
                    navigate(`/children/${child.id}`);
                  }}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
                    isSelected
                      ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'
                  }`}
                >
                  <span>{child.avatar || '🧑'}</span>
                  <span>{child.name}</span>
                  {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-slate-950"></span>}
                </button>
              );
            })}

            <button
              onClick={() => setShowAddChildModal(true)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-semibold text-slate-400 hover:text-white hover:bg-slate-800 border border-dashed border-slate-700 transition"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add</span>
            </button>
          </div>

          {/* User Profile & Sign Out */}
          <div className="flex items-center gap-3">
            {stats.pendingRequestsCount > 0 && (
              <button
                onClick={() => navigate('/requests')}
                className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 px-3 py-1 rounded-full text-xs font-bold shadow-md shadow-amber-500/20 animate-pulse"
              >
                <span>📨</span>
                <span>{stats.pendingRequestsCount} Pending</span>
              </button>
            )}

            <div className="flex items-center gap-2 pl-3 border-l border-slate-800">
              <button
                onClick={() => navigate('/settings/profile')}
                className="flex items-center gap-1.5 text-xs font-medium text-slate-300 hover:text-emerald-400 transition"
              >
                <div className="w-7 h-7 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-xs font-bold text-white">
                  {parentEmail ? parentEmail.charAt(0).toUpperCase() : 'P'}
                </div>
                <span className="hidden lg:inline max-w-[120px] truncate">{parentEmail}</span>
              </button>

              <button
                onClick={onLogout}
                className="p-1.5 text-slate-400 hover:text-rose-400 rounded-lg hover:bg-slate-800 transition"
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
        <aside className="w-full md:w-60 shrink-0 space-y-1">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 px-3 pb-2">
            Navigation
          </div>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                  isActive
                    ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900 border border-transparent'
                }`
              }
            >
              <div className="flex items-center gap-2.5">
                <item.icon className="w-4 h-4" />
                <span>{item.label}</span>
              </div>
              {item.badge !== undefined && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 text-slate-950 font-mono">
                  {item.badge}
                </span>
              )}
            </NavLink>
          ))}
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
    </div>
  );
};
