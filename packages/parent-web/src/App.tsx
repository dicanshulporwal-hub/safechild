import React, { useState, useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { api, Child, Stats } from './api/client';
import { ToastProvider, useToast } from './components/Toast';
import { AppLayout } from './components/AppLayout';
import { AuthModal } from './components/AuthModal';
import { ChildWorkspacePage } from './pages/ChildWorkspacePage';
import { RequestsPage } from './pages/RequestsPage';
import { ParentProfilePage } from './pages/ParentProfilePage';
import { SecuritySettingsPage } from './pages/SecuritySettingsPage';
import { FamilyManagementPage } from './pages/FamilyManagementPage';
import { DeviceDiagnosticsPage } from './pages/DeviceDiagnosticsPage';
import { OperationsDashboardPage } from './pages/OperationsDashboardPage';
import { AdminParentsPage } from './pages/AdminParentsPage';
import { StatusPage } from './pages/StatusPage';
import { ReferralPage } from './pages/ReferralPage';
import { FeedbackPage } from './pages/FeedbackPage';
import { ShieldCheck } from 'lucide-react';

import { AdminLayout } from './components/AdminLayout';
import { AdminRollbackPage } from './pages/AdminRollbackPage';
import { AdminAuditPage } from './pages/AdminAuditPage';
import { AdminSupportPage } from './pages/AdminSupportPage';
import { BlockPage } from './pages/BlockPage';

function AuthenticatedApp() {
  const [userProfile, setUserProfile] = useState<any>(null);
  const [childrenList, setChildrenList] = useState<Child[]>([]);
  const [selectedChild, setSelectedChild] = useState<Child | null>(null);
  const [stats, setStats] = useState<Stats>({ todayBlockedCount: 0, pendingRequestsCount: 0, totalEventsToday: 0 });
  const [loading, setLoading] = useState(true);
  const { showToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const isSystemAdmin = userProfile?.systemRole === 'SYSTEM_ADMIN' || api.getUserRole() === 'SYSTEM_ADMIN';

  const refreshAllData = useCallback(async (currentChildId?: string) => {
    try {
      const profile = await api.getProfile().catch(() => null);
      if (profile) {
        setUserProfile(profile);
      }

      // If standard parent, fetch children
      if (profile?.systemRole !== 'SYSTEM_ADMIN') {
        const kids = await api.getChildren().catch(() => []);
        setChildrenList(kids);

        const targetChild = currentChildId
          ? kids.find((k) => k.id === currentChildId) || kids[0]
          : selectedChild
          ? kids.find((k) => k.id === selectedChild.id) || kids[0]
          : kids[0];

        if (targetChild) {
          setSelectedChild(targetChild);
          const [s, reqs] = await Promise.all([
            api.getStats(targetChild.id).catch(() => ({ todayBlockedCount: 0, pendingRequestsCount: 0, totalEventsToday: 0 })),
            api.getPendingRequests().catch(() => []),
          ]);
          setStats({
            ...s,
            pendingRequestsCount: reqs.length,
          });
        }
      }
    } catch (e) {
      console.error('Error refreshing data:', e);
    } finally {
      setLoading(false);
    }
  }, [selectedChild]);

  useEffect(() => {
    refreshAllData();
  }, []);

  // WebSocket Live Push Sync (Parent mode only)
  useEffect(() => {
    if (isSystemAdmin) return;
    const token = api.getToken();
    if (!token) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
    let ws: WebSocket | null = null;

    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        ws?.send(
          JSON.stringify({
            type: 'AUTH_PARENT',
            token: token,
            childId: selectedChild?.id,
          })
        );
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'ACCESS_REQUEST_CREATED') {
            setStats((s) => ({ ...s, pendingRequestsCount: s.pendingRequestsCount + 1 }));
            showToast(`New Ask Parent Request for ${msg.payload?.domain}`, 'warning');
          } else if (msg.type === 'ACCESS_REQUEST_RESOLVED') {
            setStats((s) => ({ ...s, pendingRequestsCount: Math.max(0, s.pendingRequestsCount - 1) }));
          }
        } catch (e) {}
      };
    } catch (e) {}

    return () => {
      ws?.close();
    };
  }, [selectedChild, isSystemAdmin]);

  const handleAddChild = async (name: string, age?: number) => {
    try {
      const { child } = await api.createChild(name, age);
      showToast(`Child profile created for ${child.name}!`, 'success');
      await refreshAllData(child.id);
      navigate(`/children/${child.id}`);
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleLogout = () => {
    api.logout();
    window.location.reload();
  };

  if (loading && !userProfile) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500 flex items-center justify-center text-slate-950 mx-auto animate-bounce font-bold shadow-lg shadow-emerald-500/20">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <h2 className="text-sm font-bold text-slate-300">Loading SafeBrowse Platform...</h2>
        </div>
      </div>
    );
  }

  // DEDICATED SYSTEM ADMIN CONSOLE EXPERIENCE
  if (isSystemAdmin) {
    return (
      <AdminLayout
        adminEmail={userProfile?.email || api.getUserEmail()}
        onLogout={handleLogout}
      >
        <Routes>
          <Route path="/" element={<Navigate to="/admin/parents" replace />} />
          <Route path="/admin" element={<Navigate to="/admin/parents" replace />} />
          <Route path="/admin/parents" element={<AdminParentsPage />} />
          <Route path="/admin/operations" element={<OperationsDashboardPage />} />
          <Route path="/admin/rollback" element={<AdminRollbackPage />} />
          <Route path="/admin/audit" element={<AdminAuditPage />} />
          <Route path="/admin/support" element={<AdminSupportPage />} />
          <Route path="/settings/security" element={<SecuritySettingsPage />} />
          <Route path="/status" element={<StatusPage />} />
          <Route path="*" element={<Navigate to="/admin/parents" replace />} />
        </Routes>
      </AdminLayout>
    );
  }

  // STANDARD PARENT WORKSPACE EXPERIENCE
  return (
    <AppLayout
      childrenList={childrenList}
      selectedChild={selectedChild}
      onSelectChild={setSelectedChild}
      onAddChild={handleAddChild}
      stats={stats}
      parentEmail={userProfile?.email || api.getUserEmail()}
      onLogout={handleLogout}
    >
      <Routes>
        <Route
          path="/"
          element={
            childrenList.length > 0 ? (
              <Navigate to={`/children/${selectedChild?.id || childrenList[0].id}`} replace />
            ) : (
              <div className="p-12 text-center text-slate-400">Please create a child profile to begin.</div>
            )
          }
        />
        <Route
          path="/dashboard"
          element={
            childrenList.length > 0 ? (
              <Navigate to={`/children/${selectedChild?.id || childrenList[0].id}`} replace />
            ) : (
              <div className="p-12 text-center text-slate-400">Please create a child profile to begin.</div>
            )
          }
        />
        <Route path="/children/:childId" element={<ChildWorkspacePage childrenList={childrenList} />} />
        <Route path="/requests" element={<RequestsPage />} />
        <Route path="/requests/:requestId" element={<RequestsPage />} />
        <Route path="/devices/:deviceId/diagnostics" element={<DeviceDiagnosticsPage />} />
        <Route path="/settings/profile" element={<ParentProfilePage />} />
        <Route path="/settings/security" element={<SecuritySettingsPage />} />
        <Route path="/family" element={<FamilyManagementPage />} />
        <Route path="/settings/family" element={<FamilyManagementPage />} />
        <Route path="/admin" element={<AdminParentsPage />} />
        <Route path="/admin/parents" element={<AdminParentsPage />} />
        <Route path="/admin/operations" element={<OperationsDashboardPage />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/blocked" element={<BlockPage />} />
        <Route path="/referrals" element={<ReferralPage />} />
        <Route path="/feedback" element={<FeedbackPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppLayout>
  );
}

export function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(Boolean(api.getToken()));

  // Public routes that don't require parent authentication (e.g. child block screen)
  if (window.location.pathname.startsWith('/blocked')) {
    return (
      <BrowserRouter>
        <BlockPage />
      </BrowserRouter>
    );
  }

  const handleAuthSuccess = () => {
    setIsAuthenticated(true);
  };

  if (!isAuthenticated) {
    return <AuthModal onSuccess={handleAuthSuccess} />;
  }

  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthenticatedApp />
      </ToastProvider>
    </BrowserRouter>
  );
}
