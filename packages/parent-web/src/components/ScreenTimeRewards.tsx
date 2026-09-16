import React, { useState, useEffect } from 'react';
import { Award, CheckCircle2, Clock, Plus, Sparkles, Star, Trophy, ArrowRight, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { useToast } from './Toast';

interface ScreenTimeRewardsProps {
  childId: string;
  childName: string;
}

interface QuestItem {
  id: string;
  title: string;
  rewardMinutes: number;
  status: 'PENDING' | 'COMPLETED_WAITING_APPROVAL' | 'APPROVED';
  icon: string;
  createdAt: string;
}

export const ScreenTimeRewards: React.FC<ScreenTimeRewardsProps> = ({ childId, childName }) => {
  const { showToast } = useToast();
  const [quests, setQuests] = useState<QuestItem[]>([]);
  const [customTitle, setCustomTitle] = useState('');
  const [customMinutes, setCustomMinutes] = useState('30');
  const [customIcon, setCustomIcon] = useState('🎯');
  const [showAddModal, setShowAddModal] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  useEffect(() => {
    loadQuests();
  }, [childId]);

  const loadQuests = () => {
    const key = `sb_quests_${childId}`;
    const saved = localStorage.getItem(key);
    if (saved) {
      try {
        setQuests(JSON.parse(saved));
        return;
      } catch (e) {}
    }

    const defaultQuests: QuestItem[] = [
      {
        id: `q-1-${childId}`,
        title: 'Complete Math & Science Homework',
        rewardMinutes: 30,
        status: 'COMPLETED_WAITING_APPROVAL',
        icon: '📐',
        createdAt: new Date().toISOString(),
      },
      {
        id: `q-2-${childId}`,
        title: '30 mins Duolingo Language Lesson',
        rewardMinutes: 20,
        status: 'PENDING',
        icon: '🦉',
        createdAt: new Date().toISOString(),
      },
      {
        id: `q-3-${childId}`,
        title: 'Clean and Organize Study Desk',
        rewardMinutes: 15,
        status: 'PENDING',
        icon: '🧹',
        createdAt: new Date().toISOString(),
      },
    ];
    setQuests(defaultQuests);
    localStorage.setItem(key, JSON.stringify(defaultQuests));
  };

  const saveQuests = (updated: QuestItem[]) => {
    setQuests(updated);
    localStorage.setItem(`sb_quests_${childId}`, JSON.stringify(updated));
  };

  const handleApproveQuest = async (quest: QuestItem) => {
    setApprovingId(quest.id);
    try {
      // Fetch active budgets to add bonus time if any exist
      const budgets = await api.getUsageBudgets(childId).catch(() => []);
      if (budgets && budgets.length > 0) {
        // Add bonus time to the first active budget
        const targetBudget = budgets[0].budget || budgets[0];
        await api.addBonusTime(childId, targetBudget.id, quest.rewardMinutes).catch(() => {});
      }

      const updated = quests.map((q) =>
        q.id === quest.id ? { ...q, status: 'APPROVED' as const } : q
      );
      saveQuests(updated);
      showToast(`🌟 Granted +${quest.rewardMinutes}m bonus screen time to ${childName}!`, 'success');
    } catch (e: any) {
      showToast(e.message || 'Error granting bonus time', 'error');
    } finally {
      setApprovingId(null);
    }
  };

  const handleAddQuest = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customTitle.trim()) return;

    const newQuest: QuestItem = {
      id: `q-${Date.now()}`,
      title: customTitle.trim(),
      rewardMinutes: Math.max(5, Number(customMinutes)),
      status: 'PENDING',
      icon: customIcon || '🎯',
      createdAt: new Date().toISOString(),
    };

    const updated = [newQuest, ...quests];
    saveQuests(updated);
    setCustomTitle('');
    setShowAddModal(false);
    showToast(`Created new quest: ${newQuest.title} (+${newQuest.rewardMinutes}m)`, 'success');
  };

  const handleDeleteQuest = (questId: string) => {
    const updated = quests.filter((q) => q.id !== questId);
    saveQuests(updated);
    showToast('Quest removed.', 'info');
  };

  const handleSimulateChildSubmit = (questId: string) => {
    const updated = quests.map((q) =>
      q.id === questId ? { ...q, status: 'COMPLETED_WAITING_APPROVAL' as const } : q
    );
    saveQuests(updated);
    showToast('Simulated child submission for parent approval!', 'info');
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-xl space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-800/80">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-amber-500/20 border border-amber-500/30 text-amber-400 flex items-center justify-center shrink-0">
            <Trophy className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-extrabold text-white tracking-tight">Earn Screen Time Quests</h3>
            <p className="text-xs text-slate-400">
              Positive habit builder: reward completed homework and chores with bonus screen time.
            </p>
          </div>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="px-3.5 py-2 bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-400 hover:to-yellow-400 text-slate-950 text-xs font-extrabold rounded-2xl transition shadow-lg shadow-amber-500/20 flex items-center gap-1.5 cursor-pointer self-start sm:self-auto"
        >
          <Plus className="w-3.5 h-3.5 stroke-[3]" />
          <span>New Quest</span>
        </button>
      </div>

      <div className="space-y-3">
        {quests.length === 0 ? (
          <div className="text-center py-8 text-xs text-slate-500">
            No active quests. Click "New Quest" to create one.
          </div>
        ) : (
          quests.map((q) => (
            <div
              key={q.id}
              className={`p-4 rounded-2xl border transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                q.status === 'COMPLETED_WAITING_APPROVAL'
                  ? 'bg-amber-950/20 border-amber-500/40 shadow-lg shadow-amber-950/20'
                  : q.status === 'APPROVED'
                  ? 'bg-emerald-950/20 border-emerald-500/30'
                  : 'bg-slate-950/60 border-slate-800/80 hover:border-slate-700/80'
              }`}
            >
              <div className="flex items-start sm:items-center gap-3.5">
                <span className="text-2xl p-1.5 rounded-xl bg-slate-900 border border-slate-800 shrink-0">
                  {q.icon}
                </span>
                <div>
                  <div className="text-xs font-extrabold text-white flex items-center gap-2 flex-wrap">
                    <span>{q.title}</span>
                    <span className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full font-mono font-bold">
                      +{q.rewardMinutes} min
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1">
                    {q.status === 'COMPLETED_WAITING_APPROVAL' && (
                      <span className="text-amber-400 font-semibold animate-pulse flex items-center gap-1">
                        ⚡ Submitted by {childName} • Awaiting Parent Approval
                      </span>
                    )}
                    {q.status === 'APPROVED' && (
                      <span className="text-emerald-400 font-semibold flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Completed • +{q.rewardMinutes}m Bonus Granted
                      </span>
                    )}
                    {q.status === 'PENDING' && (
                      <span className="text-slate-500">In progress by {childName}</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2 self-end sm:self-auto">
                {q.status === 'COMPLETED_WAITING_APPROVAL' && (
                  <button
                    disabled={approvingId === q.id}
                    onClick={() => handleApproveQuest(q)}
                    className="px-4 py-2 bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-400 hover:to-yellow-400 text-slate-950 font-black text-xs rounded-xl shadow-lg transition flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Approve & Grant</span>
                  </button>
                )}

                {q.status === 'PENDING' && (
                  <button
                    onClick={() => handleSimulateChildSubmit(q.id)}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-[11px] font-bold transition cursor-pointer"
                    title="Simulate child completing this task"
                  >
                    Submit Completion
                  </button>
                )}

                <button
                  onClick={() => handleDeleteQuest(q.id)}
                  className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-xl transition cursor-pointer"
                  title="Delete Quest"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-md w-full p-6 sm:p-8 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-sm font-extrabold text-white uppercase tracking-wider">Create Homework Quest</h3>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-white">
                ✕
              </button>
            </div>

            <form onSubmit={handleAddQuest} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1.5">Quest Title</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Read 20 pages of History book"
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-4 py-2.5 text-white text-xs font-medium focus:outline-none focus:border-amber-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1.5">Bonus Screen Time</label>
                  <input
                    type="number"
                    min="5"
                    max="180"
                    required
                    value={customMinutes}
                    onChange={(e) => setCustomMinutes(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-4 py-2.5 text-white text-xs font-medium focus:outline-none focus:border-amber-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1.5">Quest Icon</label>
                  <select
                    value={customIcon}
                    onChange={(e) => setCustomIcon(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-4 py-2.5 text-white text-xs font-bold focus:outline-none focus:border-amber-500"
                  >
                    <option value="🎯">🎯 Target / Goal</option>
                    <option value="📚">📚 Reading Book</option>
                    <option value="📐">📐 Math Homework</option>
                    <option value="🧹">🧹 Clean Room</option>
                    <option value="🐕">🐕 Walk the Dog</option>
                    <option value="🎹">🎹 Music Practice</option>
                    <option value="🏃">🏃 Exercise / Sport</option>
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-xl cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-400 hover:to-yellow-400 text-slate-950 text-xs font-extrabold rounded-xl shadow cursor-pointer"
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
