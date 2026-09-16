const fs = require('fs');
const path = require('path');

// 1. NotificationCenter.tsx
const notifCode = `import React, { useState } from 'react';
import { Bell, CheckCircle2, ShieldAlert, Clock, X, Check, ArrowRight } from 'lucide-react';

export interface NotificationItem {
  id: string;
  type: 'REQUEST' | 'LIMIT' | 'SECURITY';
  title: string;
  description: string;
  timestamp: string;
  read: boolean;
  domain?: string;
  childName?: string;
  requestId?: string;
}

export const NotificationCenter: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([
    {
      id: 'notif-1',
      type: 'REQUEST',
      title: 'Website Unlock Request',
      description: 'Alex requested access to discord.com for school project',
      timestamp: '2m ago',
      read: false,
      domain: 'discord.com',
      childName: 'Alex',
    },
    {
      id: 'notif-2',
      type: 'LIMIT',
      title: 'Daily Screen Time Limit Reached',
      description: 'Maya reached her daily 60-minute limit on Gaming & Roblox',
      timestamp: '14m ago',
      read: false,
      childName: 'Maya',
    },
    {
      id: 'notif-3',
      type: 'SECURITY',
      title: 'Tamper Watchdog Verification',
      description: 'DNS loopback lock (127.0.0.1:53) verified on Alex Laptop',
      timestamp: '1h ago',
      read: true,
    },
  ]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const handleQuickApprove = (id: string, domain?: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true, description: 'Approved for 15m' } : n))
    );
    alert('Temporary 15-minute access approved for ' + (domain || 'website'));
  };

  const handleMarkAllRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const handleDismiss = (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition relative cursor-pointer"
        title="Notification Center"
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-amber-400 ring-2 ring-slate-900 animate-pulse"></span>
        )}
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute right-0 mt-2 w-80 sm:w-96 bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl z-50 p-4 space-y-3 animate-fadeIn backdrop-blur-xl">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Bell className="w-4 h-4 text-emerald-400" />
                <span className="text-xs font-bold text-white uppercase tracking-wider">
                  Notifications ({unreadCount} new)
                </span>
              </div>
              {unreadCount > 0 && (
                <button
                  onClick={handleMarkAllRead}
                  className="text-[10px] text-slate-400 hover:text-emerald-400 font-semibold cursor-pointer"
                >
                  Mark all read
                </button>
              )}
            </div>

            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {notifications.length === 0 ? (
                <div className="text-center py-6 text-xs text-slate-500">
                  No notifications at this time.
                </div>
              ) : (
                notifications.map((notif) => (
                  <div
                    key={notif.id}
                    className={'p-3 rounded-xl border transition text-xs space-y-2 ' + (
                      notif.read
                        ? 'bg-slate-950/40 border-slate-800/60 text-slate-400'
                        : 'bg-slate-950 border-emerald-500/30 text-slate-200'
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {notif.type === 'REQUEST' && <span className="text-amber-400">📨</span>}
                        {notif.type === 'LIMIT' && <span className="text-blue-400">⏰</span>}
                        {notif.type === 'SECURITY' && <span className="text-emerald-400">🛡️</span>}
                        <span className="font-bold text-white text-[11px]">{notif.title}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-slate-500 font-mono">{notif.timestamp}</span>
                        <button
                          onClick={() => handleDismiss(notif.id)}
                          className="text-slate-500 hover:text-rose-400"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    </div>

                    <p className="text-[11px] text-slate-300 leading-snug">{notif.description}</p>

                    {notif.type === 'REQUEST' && !notif.read && (
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          onClick={() => handleQuickApprove(notif.id, notif.domain)}
                          className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[10px] font-bold transition flex items-center gap-1 cursor-pointer"
                        >
                          <Check className="w-3 h-3" />
                          <span>Approve 15m</span>
                        </button>
                        <button
                          onClick={() => handleDismiss(notif.id)}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-[10px] font-bold transition cursor-pointer"
                        >
                          Deny
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
`;

// 2. WeeklySafetyDigestModal.tsx
const digestCode = `import React from 'react';
import { ShieldCheck, Printer, Download, Sparkles, X, Trophy, CheckCircle, Flame, Users, Gamepad2, GraduationCap } from 'lucide-react';

interface WeeklySafetyDigestModalProps {
  childName: string;
  onClose: () => void;
}

export const WeeklySafetyDigestModal: React.FC<WeeklySafetyDigestModalProps> = ({
  childName,
  onClose,
}) => {
  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-2xl w-full p-6 sm:p-8 space-y-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-slate-800">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">📊</span>
              <h2 className="text-xl font-extrabold text-white tracking-tight">
                Weekly Family Safety Digest
              </h2>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Safety report card & learning analytics for <span className="text-white font-bold">{childName}</span> (Past 7 Days)
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handlePrint}
              className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition flex items-center gap-1.5 text-xs font-semibold"
              title="Print or Save as PDF"
            >
              <Printer className="w-4 h-4" />
              <span className="hidden sm:inline">Print / PDF</span>
            </button>
            <button onClick={onClose} className="p-2 text-slate-400 hover:text-white rounded-xl">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Safety Score Card */}
        <div className="bg-gradient-to-r from-emerald-950/50 via-slate-950 to-slate-950 border border-emerald-500/30 rounded-2xl p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
              Overall Safety Rating
            </span>
            <div className="flex items-baseline gap-3 mt-1">
              <span className="text-4xl font-black text-white">98 / 100</span>
              <span className="text-sm font-black text-emerald-300 bg-emerald-500/20 px-2.5 py-0.5 rounded-full border border-emerald-500/30">
                GRADE A+
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Zero security breaches. 100% of explicit and malware domains neutralized.
            </p>
          </div>

          <div className="w-16 h-16 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0 shadow-lg shadow-emerald-500/10">
            <Trophy className="w-8 h-8" />
          </div>
        </div>

        {/* Threat Prevention Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 text-center">
            <div className="text-2xl font-extrabold text-rose-400">47</div>
            <div className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">Threats Blocked</div>
          </div>
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 text-center">
            <div className="text-2xl font-extrabold text-indigo-400">14.2h</div>
            <div className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">Study & School</div>
          </div>
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 text-center">
            <div className="text-2xl font-extrabold text-blue-400">5.8h</div>
            <div className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">Screen Time / Games</div>
          </div>
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 text-center">
            <div className="text-2xl font-extrabold text-emerald-400">100%</div>
            <div className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">Bedtime Adherence</div>
          </div>
        </div>

        {/* Category Breakdown Progress Bar */}
        <div className="bg-slate-950 p-5 rounded-2xl border border-slate-800 space-y-3">
          <h4 className="text-xs font-bold text-white uppercase tracking-wider">Browsing Category Distribution</h4>
          <div className="w-full h-3 rounded-full bg-slate-800 overflow-hidden flex">
            <div className="bg-emerald-500 h-full" style={{ width: '45%' }} title="Education: 45%"></div>
            <div className="bg-indigo-500 h-full" style={{ width: '25%' }} title="Gaming: 25%"></div>
            <div className="bg-blue-500 h-full" style={{ width: '20%' }} title="Social: 20%"></div>
            <div className="bg-amber-500 h-full" style={{ width: '10%' }} title="Streaming: 10%"></div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
              <span className="text-slate-300 font-semibold">Education (45%)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-indigo-500"></span>
              <span className="text-slate-300 font-semibold">Gaming (25%)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-500"></span>
              <span className="text-slate-300 font-semibold">Social Media (20%)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span>
              <span className="text-slate-300 font-semibold">Streaming (10%)</span>
            </div>
          </div>
        </div>

        {/* Top Educational Highlights */}
        <div className="bg-slate-950 p-5 rounded-2xl border border-slate-800 space-y-3">
          <h4 className="text-xs font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
            <GraduationCap className="w-4 h-4" />
            <span>Top Visited Educational Resources</span>
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-between">
              <span className="font-mono text-white">khanacademy.org</span>
              <span className="text-emerald-400 font-bold">6.5 hrs</span>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-between">
              <span className="font-mono text-white">wikipedia.org</span>
              <span className="text-emerald-400 font-bold">4.2 hrs</span>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-between">
              <span className="font-mono text-white">duolingo.com</span>
              <span className="text-emerald-400 font-bold">2.1 hrs</span>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-between">
              <span className="font-mono text-white">quizlet.com</span>
              <span className="text-emerald-400 font-bold">1.4 hrs</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end pt-2 border-t border-slate-800">
          <button
            onClick={onClose}
            className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition shadow"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
`;

// 3. ScreenTimeRewards.tsx
const rewardsCode = `import React, { useState } from 'react';
import { Award, CheckCircle2, Clock, Plus, Sparkles, Star, Trophy, ArrowRight } from 'lucide-react';
import { api } from '../api/client';

interface ScreenTimeRewardsProps {
  childId: string;
  childName: string;
}

export const ScreenTimeRewards: React.FC<ScreenTimeRewardsProps> = ({ childId, childName }) => {
  const [quests, setQuests] = useState([
    { id: 'q-1', title: 'Complete Math Homework', rewardMinutes: 30, status: 'COMPLETED_WAITING_APPROVAL', icon: '📐' },
    { id: 'q-2', title: '30 mins Duolingo Practice', rewardMinutes: 20, status: 'PENDING', icon: '🦉' },
    { id: 'q-3', title: 'Clean and Organize Study Desk', rewardMinutes: 15, status: 'PENDING', icon: '🧹' },
  ]);

  const [customTitle, setCustomTitle] = useState('');
  const [customMinutes, setCustomMinutes] = useState('30');
  const [showAddModal, setShowAddModal] = useState(false);

  const handleApproveQuest = async (questId: string, minutes: number) => {
    try {
      setQuests((prev) =>
        prev.map((q) => (q.id === questId ? { ...q, status: 'APPROVED' } : q))
      );
      alert('🌟 Quest Approved! Granted +' + minutes + ' min bonus screen time to ' + childName);
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleAddQuest = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customTitle.trim()) return;
    setQuests((prev) => [
      ...prev,
      {
        id: 'q-' + Date.now(),
        title: customTitle.trim(),
        rewardMinutes: Number(customMinutes),
        status: 'PENDING',
        icon: '🎯',
      },
    ]);
    setCustomTitle('');
    setShowAddModal(false);
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
      <div className="flex items-center justify-between pb-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4 text-amber-400" />
          <h3 className="text-sm font-bold text-white uppercase tracking-wider">Earn Screen Time Quests</h3>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 text-xs font-bold rounded-xl transition flex items-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Quest</span>
        </button>
      </div>

      <p className="text-xs text-slate-400">
        Motivate {childName} by rewarding completed chores and homework with bonus screen time.
      </p>

      <div className="space-y-3 pt-1">
        {quests.map((q) => (
          <div
            key={q.id}
            className={'p-4 rounded-xl border transition flex items-center justify-between ' + (
              q.status === 'COMPLETED_WAITING_APPROVAL'
                ? 'bg-amber-950/20 border-amber-500/40 shadow-inner'
                : q.status === 'APPROVED'
                ? 'bg-emerald-950/20 border-emerald-500/30'
                : 'bg-slate-950/60 border-slate-800'
            )}
          >
            <div className="flex items-center gap-3">
              <span className="text-2xl">{q.icon}</span>
              <div>
                <div className="text-xs font-bold text-white flex items-center gap-2">
                  <span>{q.title}</span>
                  <span className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded-full font-mono font-bold">
                    +{q.rewardMinutes} min
                  </span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  {q.status === 'COMPLETED_WAITING_APPROVAL' && (
                    <span className="text-amber-400 font-semibold animate-pulse">
                      ⚡ Child submitted completion · Awaiting parent approval
                    </span>
                  )}
                  {q.status === 'APPROVED' && (
                    <span className="text-emerald-400 font-semibold">
                      ✅ Completed & Bonus Time Awarded
                    </span>
                  )}
                  {q.status === 'PENDING' && 'In progress by child'}
                </div>
              </div>
            </div>

            {q.status === 'COMPLETED_WAITING_APPROVAL' && (
              <button
                onClick={() => handleApproveQuest(q.id, q.rewardMinutes)}
                className="px-3.5 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs rounded-xl shadow transition flex items-center gap-1 cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Approve & Grant</span>
              </button>
            )}
          </div>
        ))}
      </div>

      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <h3 className="text-sm font-bold text-white uppercase">Create Homework / Chore Quest</h3>
            <form onSubmit={handleAddQuest} className="space-y-3">
              <div>
                <label className="block text-[11px] font-bold text-slate-400 mb-1">Quest Title</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Read 20 pages of Book"
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-400 mb-1">Reward (Minutes of Bonus Time)</label>
                <input
                  type="number"
                  min="5"
                  max="120"
                  required
                  value={customMinutes}
                  onChange={(e) => setCustomMinutes(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-xs"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-400 text-xs font-semibold rounded-xl"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold rounded-xl"
                >
                  Create Quest
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
`;

fs.writeFileSync(path.join(__dirname, '../packages/parent-web/src/components/NotificationCenter.tsx'), notifCode);
fs.writeFileSync(path.join(__dirname, '../packages/parent-web/src/components/WeeklySafetyDigestModal.tsx'), digestCode);
fs.writeFileSync(path.join(__dirname, '../packages/parent-web/src/components/ScreenTimeRewards.tsx'), rewardsCode);

console.log('✅ UI components successfully created!');

