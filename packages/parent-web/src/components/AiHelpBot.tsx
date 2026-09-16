import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShieldCheck,
  X,
  Send,
  Sparkles,
  ChevronRight,
  Shield,
  Clock,
  Moon,
  Smartphone,
  Utensils,
  Key,
  Maximize2,
  Minimize2,
  LifeBuoy,
  HeartHandshake,
  MessageCircleQuestion,
} from 'lucide-react';

interface ChatMessage {
  id: string;
  sender: 'user' | 'bot';
  text: string;
  actionButton?: {
    label: string;
    path: string;
  };
  timestamp: string;
}

const FAQ_KNOWLEDGE_BASE = [
  {
    keywords: ['block', 'website', 'url', 'domain', 'blacklist', 'youtube', 'tiktok', 'roblox'],
    answer:
      'To block or allow specific websites:\n1. Open your child\'s workspace from the sidebar.\n2. Go to the **Web Protection** tab.\n3. Type the domain name (e.g. `tiktok.com` or `youtube.com`) and choose **BLOCK** or **ALLOW**.\n4. Rules synchronize to linked Windows & Android devices immediately.',
    action: { label: 'Open Child Protection', path: '/dashboard' },
  },
  {
    keywords: ['app', 'limit', 'game', 'time limit', 'roblox', 'minecraft', 'discord', 'steam', 'process', 'taskkill'],
    answer:
      'To set daily application time limits:\n1. Open your child\'s profile and switch to the **App Limits** tab.\n2. Set a daily cap (e.g. 45 minutes / day) for games like Roblox, Minecraft, or Discord.\n3. The Windows Agent actively monitors running desktop apps, delivers a **5-minute warning** before cutoff, and automatically closes the application when time is up.',
    action: { label: 'Manage App Limits', path: '/dashboard' },
  },
  {
    keywords: ['pair', 'device', 'laptop', 'phone', 'install', 'setup', 'code', 'connect'],
    answer:
      'To pair a child device:\n1. Click **"Pair New Device"** in the child workspace to generate a 6-digit code (e.g. `SB-K8X9-M2W7`).\n2. **Windows**: Run `SafeBrowseChild.exe --pair SB-XXXXXX` on the child\'s PC.\n3. **Android**: Enter the code in the SafeBrowse Android App and allow VPN permissions.\n4. The device links in seconds with offline policy caching.',
    action: { label: 'Pair New Device', path: '/dashboard' },
  },
  {
    keywords: ['bedtime', 'curfew', 'night', 'sleep', 'routine', 'schedule', 'downtime'],
    answer:
      'To schedule Bedtime routines:\n1. Go to your child\'s profile $\\rightarrow$ **Bedtime & Routines**.\n2. Set your weekday and weekend sleep curfews (e.g., 21:30 to 07:00).\n3. During bedtime, non-educational web browsing and desktop games are automatically locked out.',
    action: { label: 'Configure Bedtime', path: '/dashboard' },
  },
  {
    keywords: ['pause', 'dinner', 'lock', 'instant lock', 'freeze', 'dinner time'],
    answer:
      'Use **Quick Remote Actions** in the top dashboard bar:\n- 🔒 **Instant Lock**: Cuts internet and locks games immediately.\n- ⏸️ **Pause (15m / 30m / 1h)**: Pauses access with automatic timer resumption.\n- 🍽️ **Dinner Time**: Enforces a 45-minute family curfew across all child devices in $<200\\text{ ms}$.',
    action: { label: 'Open Dashboard Controls', path: '/dashboard' },
  },
  {
    keywords: ['request', 'approve', 'unlock', 'permission', 'ask parent'],
    answer:
      'When your child visits a blocked page, they can click **"Ask Parent"** on the block screen.\n- You will receive a **real-time Web Push notification** on your screen.\n- Open the **Ask Parent Requests** inbox to approve for 15m, 1 hour, or always.',
    action: { label: 'View Pending Requests', path: '/requests' },
  },
  {
    keywords: ['2fa', 'mfa', 'push', 'notification', 'security', 'authenticator', 'password'],
    answer:
      'To enable Two-Factor Authentication & Web Push:\n1. Go to **Security & Sessions** in the sidebar.\n2. Enable **Real-Time Web Push Alerts** to receive lock-screen alerts when tab is closed.\n3. Click **Set Up Authenticator App** to scan the QR code with Google/Microsoft Authenticator.',
    action: { label: 'Security & 2FA Settings', path: '/settings/security' },
  },
  {
    keywords: ['family', 'co-parent', 'invite', 'member', 'owner', 'role'],
    answer:
      'To manage family members:\n1. Open **Family & Co-Parents**.\n2. Click **Invite Member** to send a secure invitation token.\n3. Assign roles: **PARENT** (can manage rules & approve requests) or **VIEWER** (read-only activity view).',
    action: { label: 'Family Management', path: '/family' },
  },
];

export const AiHelpBot: React.FC = () => {
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      sender: 'bot',
      text: "👋 Hello! I'm your **SafeBrowse Family Guardian**. How can I assist you with child web protection, app limits, or family safety rules today?",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ]);

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen]);

  const findBestAnswer = (query: string): { answer: string; action?: { label: string; path: string } } => {
    const q = query.toLowerCase();
    let bestMatch: (typeof FAQ_KNOWLEDGE_BASE)[0] | null = null;
    let highestScore = 0;

    for (const item of FAQ_KNOWLEDGE_BASE) {
      let score = 0;
      for (const kw of item.keywords) {
        if (q.includes(kw)) {
          score += 1;
        }
      }
      if (score > highestScore) {
        highestScore = score;
        bestMatch = item;
      }
    }

    if (bestMatch && highestScore > 0) {
      return { answer: bestMatch.answer, action: bestMatch.action };
    }

    return {
      answer:
        "I'm here to guide you with all SafeBrowse family safety features:\n- **🛡️ Web Protection & Strict SafeSearch**\n- **⏱️ Active App Time Limits (Roblox, Minecraft, etc.)**\n- **💻 Device Pairing (Windows PC & Android Phone/Tablet)**\n- **🌙 Bedtime Schedules & 🍽️ 1-Tap Dinner Time**\n- **📨 Real-Time Access Requests & 2FA Setup**\n\nAsk me any question like *'How do I block YouTube?'* or *'How to set up App Time Limits?'*",
      action: { label: 'Explore Child Protection', path: '/dashboard' },
    };
  };

  const handleSend = (textToSend?: string) => {
    const query = textToSend || input;
    if (!query.trim()) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      sender: 'user',
      text: query.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);

    setTimeout(() => {
      const match = findBestAnswer(query);
      const botMsg: ChatMessage = {
        id: `bot-${Date.now()}`,
        sender: 'bot',
        text: match.answer,
        actionButton: match.action,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, botMsg]);
      setIsTyping(false);
    }, 450);
  };

  const handleQuickChip = (prompt: string) => {
    handleSend(prompt);
  };

  return (
    <>
      {/* Floating Guardian Button */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-500 hover:from-emerald-500 hover:to-teal-500 text-slate-950 font-black text-xs px-4 py-3 rounded-full shadow-2xl shadow-emerald-500/30 hover:scale-105 active:scale-95 transition-all duration-200 border border-emerald-300/40 cursor-pointer"
          title="Open SafeBrowse Family Guardian"
        >
          <div className="relative">
            <ShieldCheck className="w-5 h-5 text-slate-950 stroke-[2.5]" />
            <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-300 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-white"></span>
            </span>
          </div>
          <span className="tracking-tight">Family Guardian</span>
          <Sparkles className="w-3.5 h-3.5 text-amber-300" />
        </button>
      )}

      {/* Interactive Guardian Assistant Window */}
      {isOpen && (
        <div
          className={`fixed z-50 bottom-6 right-6 bg-slate-900/95 backdrop-blur-xl border border-emerald-500/30 rounded-3xl shadow-2xl flex flex-col transition-all duration-300 overflow-hidden ${
            isExpanded
              ? 'w-[92vw] max-w-2xl h-[85vh]'
              : 'w-[90vw] sm:w-[420px] h-[580px]'
          }`}
        >
          {/* Header */}
          <div className="p-4 bg-gradient-to-r from-slate-950 via-slate-900 to-emerald-950/60 border-b border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center text-slate-950 shadow-md shadow-emerald-500/20">
                <ShieldCheck className="w-5 h-5 text-slate-950 stroke-[2.5]" />
              </div>
              <div>
                <div className="text-xs font-black text-white flex items-center gap-1.5 tracking-tight">
                  <span>SafeBrowse Family Guardian</span>
                  <Sparkles className="w-3 h-3 text-amber-400" />
                </div>
                <div className="text-[10px] text-emerald-400 flex items-center gap-1 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block animate-pulse"></span>
                  Parental Safety & Assistant Guide
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1.5 text-slate-400">
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="p-1.5 hover:text-white hover:bg-slate-800 rounded-xl transition cursor-pointer"
                title={isExpanded ? 'Minimize' : 'Expand'}
              >
                {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1.5 hover:text-white hover:bg-slate-800 rounded-xl transition cursor-pointer"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Quick Topic Chips */}
          <div className="px-3.5 py-2.5 bg-slate-950/70 border-b border-slate-800/80 flex items-center gap-1.5 overflow-x-auto scrollbar-none text-[11px]">
            <button
              onClick={() => handleQuickChip('How do I block a website like YouTube?')}
              className="px-2.5 py-1 bg-slate-900 hover:bg-emerald-600/20 text-slate-300 hover:text-emerald-300 border border-slate-800 hover:border-emerald-500/40 rounded-full whitespace-nowrap transition flex items-center gap-1 cursor-pointer"
            >
              <Shield className="w-3 h-3 text-rose-400" /> Block Websites
            </button>
            <button
              onClick={() => handleQuickChip('How do App Time Limits work for games like Roblox?')}
              className="px-2.5 py-1 bg-slate-900 hover:bg-emerald-600/20 text-slate-300 hover:text-emerald-300 border border-slate-800 hover:border-emerald-500/40 rounded-full whitespace-nowrap transition flex items-center gap-1 cursor-pointer"
            >
              <Clock className="w-3 h-3 text-amber-400" /> App Time Limits
            </button>
            <button
              onClick={() => handleQuickChip('How do I pair a child Windows laptop?')}
              className="px-2.5 py-1 bg-slate-900 hover:bg-emerald-600/20 text-slate-300 hover:text-emerald-300 border border-slate-800 hover:border-emerald-500/40 rounded-full whitespace-nowrap transition flex items-center gap-1 cursor-pointer"
            >
              <Smartphone className="w-3 h-3 text-cyan-400" /> Device Pairing
            </button>
            <button
              onClick={() => handleQuickChip('How does Dinner Time & Instant Lock work?')}
              className="px-2.5 py-1 bg-slate-900 hover:bg-emerald-600/20 text-slate-300 hover:text-emerald-300 border border-slate-800 hover:border-emerald-500/40 rounded-full whitespace-nowrap transition flex items-center gap-1 cursor-pointer"
            >
              <Utensils className="w-3 h-3 text-emerald-400" /> Dinner Time
            </button>
            <button
              onClick={() => handleQuickChip('How to set up Bedtime schedules?')}
              className="px-2.5 py-1 bg-slate-900 hover:bg-emerald-600/20 text-slate-300 hover:text-emerald-300 border border-slate-800 hover:border-emerald-500/40 rounded-full whitespace-nowrap transition flex items-center gap-1 cursor-pointer"
            >
              <Moon className="w-3 h-3 text-purple-400" /> Bedtime
            </button>
            <button
              onClick={() => handleQuickChip('How do I enable 2FA and Web Push alerts?')}
              className="px-2.5 py-1 bg-slate-900 hover:bg-emerald-600/20 text-slate-300 hover:text-emerald-300 border border-slate-800 hover:border-emerald-500/40 rounded-full whitespace-nowrap transition flex items-center gap-1 cursor-pointer"
            >
              <Key className="w-3 h-3 text-teal-400" /> 2FA & Push Alerts
            </button>
          </div>

          {/* Messages Feed */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-2.5 ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {msg.sender === 'bot' && (
                  <div className="w-7 h-7 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center text-slate-950 shrink-0 mt-0.5 shadow-sm shadow-emerald-500/20">
                    <ShieldCheck className="w-4 h-4 text-slate-950 stroke-[2.5]" />
                  </div>
                )}

                <div
                  className={`max-w-[85%] rounded-2xl p-3.5 text-xs leading-relaxed space-y-2.5 shadow-md ${
                    msg.sender === 'user'
                      ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-slate-950 font-semibold rounded-br-none'
                      : 'bg-slate-950 border border-slate-800/80 text-slate-200 rounded-bl-none'
                  }`}
                >
                  <div className="whitespace-pre-wrap">{msg.text}</div>

                  {msg.actionButton && (
                    <button
                      onClick={() => {
                        navigate(msg.actionButton!.path);
                        setIsOpen(false);
                      }}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-[11px] shadow-sm shadow-emerald-600/20 transition cursor-pointer"
                    >
                      <span>{msg.actionButton.label}</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  )}

                  <div
                    className={`text-[9px] font-mono text-right ${
                      msg.sender === 'user' ? 'text-slate-900/70' : 'text-slate-500'
                    }`}
                  >
                    {msg.timestamp}
                  </div>
                </div>
              </div>
            ))}

            {isTyping && (
              <div className="flex gap-2.5 items-center text-slate-400 text-xs">
                <div className="w-7 h-7 rounded-xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                  <ShieldCheck className="w-4 h-4" />
                </div>
                <div className="bg-slate-950 px-3.5 py-2.5 rounded-xl border border-slate-800 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce"></span>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce delay-100"></span>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce delay-200"></span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input Area */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            className="p-3 bg-slate-950 border-t border-slate-800 flex gap-2 items-center"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask Family Guardian anything about child safety..."
              className="flex-1 bg-slate-900 border border-slate-800 focus:border-emerald-500 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none transition"
            />
            <button
              type="submit"
              disabled={!input.trim()}
              className="p-2.5 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-bold rounded-xl transition disabled:opacity-40 disabled:hover:scale-100 shadow-md shadow-emerald-500/20 cursor-pointer"
              title="Send Message"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      )}
    </>
  );
};
