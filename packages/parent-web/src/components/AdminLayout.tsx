import React from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  ShieldAlert,
  Users,
  Activity,
  History,
  Radio,
  Lock,
  LogOut,
  RotateCcw,
  MessageSquare,
  ArrowRightLeft,
  Server,
} from 'lucide-react';

interface AdminLayoutProps {
  adminEmail: string;
  onLogout: () => void;
  children: React.ReactNode;
}

export const AdminLayout: React.FC<AdminLayoutProps> = ({
  adminEmail,
  onLogout,
  children,
}) => {
  const navigate = useNavigate();
  const location = useLocation();

  const navItems = [
    {
      to: '/admin/parents',
      label: 'Parent Management',
      icon: Users,
      badge: 'RBAC',
    },
    {
      to: '/admin/operations',
      label: 'Fleet & Operations',
      icon: Activity,
      badge: 'Live',
    },
    {
      to: '/admin/rollback',
      label: 'Agent Rollbacks',
      icon: RotateCcw,
      badge: undefined,
    },
    {
      to: '/admin/audit',
      label: 'System Audit Logs',
      icon: History,
      badge: undefined,
    },
    {
      to: '/admin/support',
      label: 'Support & Feedback',
      icon: MessageSquare,
      badge: undefined,
    },
    {
      to: '/settings/security',
      label: 'Admin Security',
      icon: Lock,
      badge: undefined,
    },
    {
      to: '/status',
      label: 'Global System Health',
      icon: Radio,
      badge: undefined,
    },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col antialiased">
      {/* Top Header */}
      <header className="bg-slate-900/90 border-b border-purple-900/30 sticky top-0 z-30 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between gap-4">
          {/* Brand */}
          <div
            className="flex items-center gap-3 cursor-pointer"
            onClick={() => navigate('/admin/parents')}
          >
            <div className="w-9 h-9 rounded-xl bg-purple-600 flex items-center justify-center text-white font-bold shadow-lg shadow-purple-600/30">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-lg text-white tracking-tight">SafeBrowse</span>
                <span className="text-[10px] uppercase tracking-wider font-extrabold bg-purple-500/20 text-purple-300 border border-purple-500/30 px-2 py-0.5 rounded-full">
                  System Admin
                </span>
              </div>
            </div>
          </div>

          {/* Admin User Badge & Controls */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-300">
                <div className="w-7 h-7 rounded-full bg-purple-950/80 border border-purple-600/40 flex items-center justify-center text-xs font-bold text-purple-300">
                  {adminEmail ? adminEmail.charAt(0).toUpperCase() : 'A'}
                </div>
                <span className="hidden lg:inline max-w-[140px] truncate text-slate-300">
                  {adminEmail}
                </span>
              </div>

              <button
                onClick={onLogout}
                className="p-1.5 text-slate-400 hover:text-rose-400 rounded-lg hover:bg-slate-800 transition cursor-pointer"
                title="Sign Out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <div className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col md:flex-row gap-6">
        {/* Sidebar */}
        <aside className="w-full md:w-60 shrink-0 space-y-1">
          <div className="text-[11px] font-bold uppercase tracking-wider text-purple-400/80 px-3 pb-2 flex items-center gap-1.5">
            <Server className="w-3.5 h-3.5" />
            <span>Admin Control Panel</span>
          </div>

          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                  isActive
                    ? 'bg-purple-600/15 border border-purple-500/40 text-purple-300 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900 border border-transparent'
                }`
              }
            >
              <div className="flex items-center gap-2.5">
                <item.icon className="w-4 h-4" />
                <span>{item.label}</span>
              </div>
              {item.badge && (
                <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  {item.badge}
                </span>
              )}
            </NavLink>
          ))}
        </aside>

        {/* Routed Content Area */}
        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </div>
  );
};
