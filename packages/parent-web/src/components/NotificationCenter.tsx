import React, { useState, useEffect, useRef } from 'react';
import { Bell, CheckCircle2, ShieldAlert, Clock, X, Check, Sparkles, Volume2, VolumeX, Shield, Radio, ArrowRight } from 'lucide-react';
import { api } from '../api/client';
import { useToast } from './Toast';

export interface NotificationItem {
  id: string;
  type: 'REQUEST' | 'LIMIT' | 'SECURITY';
  title: string;
  description: string;
  timestamp: string;
  read: boolean;
  domain?: string;
  childName?: string;
  childId?: string;
  deviceId?: string;
  deviceName?: string;
  requestId?: string;
}

// Synthesize pleasant luxury notification chime via Web Audio API
function playChime() {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'triangle';

    // Pleasant high melodic chord (E6 -> B6)
    osc1.frequency.setValueAtTime(1318.51, ctx.currentTime);
    osc1.frequency.exponentialRampToValueAtTime(1975.53, ctx.currentTime + 0.15);

    osc2.frequency.setValueAtTime(659.25, ctx.currentTime);
    osc2.frequency.exponentialRampToValueAtTime(987.77, ctx.currentTime + 0.15);

    gain.gain.setValueAtTime(0.01, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start();
    osc2.start();
    osc1.stop(ctx.currentTime + 0.6);
    osc2.stop(ctx.currentTime + 0.6);
  } catch (e) {
    // Audio context may be restricted by user gesture policy
  }
}

export const NotificationCenter: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [desktopNotifEnabled, setDesktopNotifEnabled] = useState(
    typeof Notification !== 'undefined' && Notification.permission === 'granted'
  );
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const { showToast } = useToast();
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    fetchLiveNotifications();
    setupWebSocket();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const fetchLiveNotifications = async () => {
    try {
      setLoading(true);
      const data = await api.getNotifications(true);
      if (Array.isArray(data)) {
        setNotifications(data);
      }
    } catch (e) {
      console.warn('Could not fetch notifications:', e);
    } finally {
      setLoading(false);
    }
  };

  const setupWebSocket = () => {
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      const token = api.getToken();
      const wsUrl = `${protocol}//${host}/ws`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (token) {
          ws.send(JSON.stringify({ type: 'AUTH_PARENT', token }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleIncomingWsMessage(msg);
        } catch (e) {
          console.error('Error parsing WS message:', e);
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        // Auto-reconnect after 4s
        setTimeout(() => {
          if (api.getToken()) setupWebSocket();
        }, 4000);
      };

      ws.onerror = () => {
        setWsConnected(false);
      };
    } catch (e) {
      console.warn('WebSocket setup error:', e);
    }
  };

  const handleIncomingWsMessage = (msg: any) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'AUTH_SUCCESS') {
      setWsConnected(true);
      return;
    }
    if (msg.type === 'AUTH_ERROR') {
      setWsConnected(false);
      return;
    }

    if (msg.type === 'ACCESS_REQUEST_CREATED') {
      const req = msg.payload;
      const newNotif: NotificationItem = {
        id: `notif-req-${req.id}`,
        requestId: req.id,
        type: 'REQUEST',
        title: 'Website Unlock Request',
        description: `New access request for ${req.domain}${req.reason ? ` (${req.reason})` : ''}`,
        timestamp: new Date().toISOString(),
        read: false,
        domain: req.domain,
        childId: req.childId,
        childName: req.deviceName || 'Child',
      };

      setNotifications((prev) => [newNotif, ...prev.filter((n) => n.id !== newNotif.id)]);
      triggerAlert('New Website Unlock Request', `Child requested access to ${req.domain}`);
    } else if (msg.type === 'NOTIFICATION_CREATED') {
      const notif = msg.payload;
      const item: NotificationItem = {
        id: notif.id || `notif-${Date.now()}`,
        type: notif.type || 'SECURITY',
        title: notif.title || 'Family Alert',
        description: notif.description || notif.message || '',
        timestamp: notif.timestamp || new Date().toISOString(),
        read: false,
        childId: notif.childId,
        childName: notif.childName,
        deviceName: notif.deviceName,
      };

      setNotifications((prev) => [item, ...prev.filter((n) => n.id !== item.id)]);
      triggerAlert(item.title, item.description);
    } else if (msg.type === 'ACCESS_REQUEST_RESOLVED') {
      const resolved = msg.payload?.request;
      if (resolved) {
        setNotifications((prev) =>
          prev.map((n) =>
            n.requestId === resolved.id
              ? { ...n, read: true, description: `Resolved: ${resolved.status} (${resolved.resolvedByName || 'Parent'})` }
              : n
          )
        );
      }
    }
  };

  const triggerAlert = (title: string, body: string) => {
    if (soundEnabled) {
      playChime();
    }

    showToast(`🔔 ${title}: ${body}`, 'info');

    if (desktopNotifEnabled && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(title, {
          body,
          icon: '/favicon.ico',
        });
      } catch (e) {}
    }
  };

  const handleRequestDesktopPermission = async () => {
    if (typeof Notification === 'undefined') {
      showToast('Desktop notifications are not supported in this browser.', 'warning');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      setDesktopNotifEnabled(true);
      showToast('Desktop notifications enabled!', 'success');
      new Notification('SafeBrowse Live Alerts Active', {
        body: 'You will receive real-time alerts when your children request access.',
      });
    } else {
      setDesktopNotifEnabled(false);
      showToast('Desktop notification permission denied.', 'info');
    }
  };

  const handleQuickResolve = async (
    notif: NotificationItem,
    action: 'APPROVE' | 'DENY',
    duration: string = '15m'
  ) => {
    if (!notif.requestId) return;
    setResolvingId(notif.id);
    try {
      await api.resolveRequest(notif.requestId, action, duration);
      setNotifications((prev) =>
        prev.map((n) =>
          n.id === notif.id
            ? {
                ...n,
                read: true,
                description:
                  action === 'APPROVE'
                    ? `Approved for ${duration} (${notif.domain})`
                    : `Denied access to ${notif.domain}`,
              }
            : n
        )
      );
      showToast(
        action === 'APPROVE'
          ? `Granted ${duration} access for ${notif.domain}`
          : `Denied access to ${notif.domain}`,
        action === 'APPROVE' ? 'success' : 'info'
      );
    } catch (e: any) {
      showToast(e.message || 'Error resolving request', 'error');
    } finally {
      setResolvingId(null);
    }
  };

  const handleMarkAsRead = async (id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    try {
      await api.markNotificationRead(id);
    } catch (e) {}
  };

  const handleMarkAllRead = async () => {
    const unreadIds = notifications.filter((n) => !n.read).map((n) => n.id);
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    try {
      await api.markAllNotificationsRead(unreadIds);
      showToast('All notifications marked as read', 'info');
    } catch (e) {}
  };

  const handleDismiss = (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  const handleTriggerTest = async () => {
    try {
      await api.triggerTestAlert('REQUEST', 'discord.com', 'School project group study');
      showToast('Test notification dispatched via WebSocket!', 'success');
    } catch (e: any) {
      showToast(e.message || 'Failed to trigger test', 'error');
    }
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <div className="relative">
      <button
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen) fetchLiveNotifications();
        }}
        className="p-2.5 rounded-2xl bg-slate-900/80 hover:bg-slate-800 text-slate-400 hover:text-white border border-slate-800 transition relative cursor-pointer shadow-sm"
        title="Real-Time Notification Center"
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-gradient-to-r from-rose-500 to-amber-500 text-white text-[9px] font-black flex items-center justify-center ring-2 ring-slate-950 animate-pulse shadow-md">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 mt-3 w-80 sm:w-96 bg-slate-900/95 border border-slate-800/90 rounded-3xl shadow-2xl z-50 p-5 space-y-4 animate-fadeIn backdrop-blur-2xl">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-800/80">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center">
                  <Bell className="w-4 h-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-extrabold text-white tracking-tight uppercase">
                      Alerts Center
                    </span>
                    {unreadCount > 0 && (
                      <span className="text-[10px] font-black bg-rose-500/20 text-rose-300 border border-rose-500/30 px-1.5 py-0.2 rounded-full font-mono">
                        {unreadCount} NEW
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] text-slate-400 mt-0.5">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        wsConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
                      }`}
                    />
                    <span>{wsConnected ? 'Live WS Connected' : 'Syncing...'}</span>
                  </div>
                </div>
              </div>

              {/* Header Action Controls */}
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setSoundEnabled(!soundEnabled)}
                  className={`p-1.5 rounded-lg text-xs transition cursor-pointer ${
                    soundEnabled ? 'text-emerald-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-800'
                  }`}
                  title={soundEnabled ? 'Mute Alert Chimes' : 'Unmute Alert Chimes'}
                >
                  {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
                </button>

                {unreadCount > 0 && (
                  <button
                    onClick={handleMarkAllRead}
                    className="text-[10px] text-slate-400 hover:text-emerald-400 font-bold px-2 py-1 rounded-lg hover:bg-slate-800 transition cursor-pointer"
                  >
                    Read All
                  </button>
                )}
              </div>
            </div>

            {/* Desktop Notification Banner if not enabled */}
            {!desktopNotifEnabled && typeof Notification !== 'undefined' && (
              <div className="p-3 bg-gradient-to-r from-indigo-950/40 via-purple-950/30 to-slate-950 rounded-2xl border border-indigo-500/30 flex items-center justify-between gap-2">
                <div className="text-[11px] text-indigo-200">
                  <strong>Enable Push Alerts</strong>
                  <div className="text-[10px] text-slate-400">Get native alerts when kids ask for access</div>
                </div>
                <button
                  onClick={handleRequestDesktopPermission}
                  className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-[10px] font-extrabold transition shadow cursor-pointer shrink-0"
                >
                  Enable
                </button>
              </div>
            )}

            {/* Notification Items List */}
            <div className="space-y-2.5 max-h-80 overflow-y-auto pr-1">
              {loading && notifications.length === 0 ? (
                <div className="text-center py-8 text-xs text-slate-400 space-y-2">
                  <div className="w-5 h-5 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin mx-auto" />
                  <div>Loading live alerts...</div>
                </div>
              ) : notifications.length === 0 ? (
                <div className="text-center py-8 text-xs text-slate-500 space-y-1.5">
                  <div className="text-2xl">✨</div>
                  <div className="font-bold text-slate-300">All Caught Up</div>
                  <div className="text-[11px]">No active alerts or unlock requests right now.</div>
                </div>
              ) : (
                notifications.map((notif) => {
                  const dateStr = notif.timestamp
                    ? new Date(notif.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : 'Just now';

                  return (
                    <div
                      key={notif.id}
                      onClick={() => !notif.read && handleMarkAsRead(notif.id)}
                      className={`p-3.5 rounded-2xl border transition-all text-xs space-y-2.5 ${
                        notif.read
                          ? 'bg-slate-950/40 border-slate-800/60 text-slate-400'
                          : 'bg-slate-950/90 border-emerald-500/40 shadow-lg shadow-emerald-950/20 text-slate-200'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          {notif.type === 'REQUEST' && (
                            <span className="p-1 rounded-lg bg-amber-500/20 text-amber-300 text-xs">📨</span>
                          )}
                          {notif.type === 'LIMIT' && (
                            <span className="p-1 rounded-lg bg-blue-500/20 text-blue-300 text-xs">⏰</span>
                          )}
                          {notif.type === 'SECURITY' && (
                            <span className="p-1 rounded-lg bg-rose-500/20 text-rose-300 text-xs">🛡️</span>
                          )}
                          <span className="font-extrabold text-white text-xs">{notif.title}</span>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-slate-500 font-mono">{dateStr}</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDismiss(notif.id);
                            }}
                            className="text-slate-500 hover:text-rose-400 p-1 rounded-md transition"
                            title="Dismiss"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <p className="text-[11px] text-slate-300 leading-snug">{notif.description}</p>

                      {/* 1-Tap Quick Action Buttons for Requests */}
                      {notif.type === 'REQUEST' && !notif.read && notif.requestId && (
                        <div className="flex items-center gap-1.5 pt-1.5 flex-wrap">
                          <button
                            disabled={resolvingId === notif.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleQuickResolve(notif, 'APPROVE', '15m');
                            }}
                            className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-[10px] font-black transition flex items-center gap-1 cursor-pointer shadow-md disabled:opacity-50"
                          >
                            <Check className="w-3 h-3 stroke-[3]" />
                            <span>15m</span>
                          </button>

                          <button
                            disabled={resolvingId === notif.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleQuickResolve(notif, 'APPROVE', '1h');
                            }}
                            className="px-2.5 py-1 bg-emerald-700/80 hover:bg-emerald-600 text-emerald-100 rounded-xl text-[10px] font-bold transition flex items-center gap-1 cursor-pointer disabled:opacity-50"
                          >
                            <span>1 Hour</span>
                          </button>

                          <button
                            disabled={resolvingId === notif.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleQuickResolve(notif, 'APPROVE', 'always');
                            }}
                            className="px-2.5 py-1 bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-300 border border-indigo-500/40 rounded-xl text-[10px] font-bold transition cursor-pointer disabled:opacity-50"
                          >
                            <span>Always</span>
                          </button>

                          <button
                            disabled={resolvingId === notif.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleQuickResolve(notif, 'DENY');
                            }}
                            className="px-2.5 py-1 bg-slate-800 hover:bg-rose-950/50 hover:text-rose-300 text-slate-400 rounded-xl text-[10px] font-bold transition cursor-pointer disabled:opacity-50"
                          >
                            Deny
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer with Instant Test Alert Trigger */}
            <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between">
              <button
                onClick={handleTriggerTest}
                className="text-[10px] font-bold text-slate-400 hover:text-amber-400 flex items-center gap-1.5 transition cursor-pointer"
                title="Send simulated live request through WebSocket"
              >
                <Sparkles className="w-3 h-3 text-amber-400" />
                <span>Trigger Test Alert</span>
              </button>

              <button
                onClick={fetchLiveNotifications}
                className="text-[10px] font-bold text-slate-400 hover:text-emerald-400 transition cursor-pointer"
              >
                Refresh
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
