import http from 'http';
import url from 'url';
import fs from 'fs';
import { spawn, exec } from 'child_process';
import { Policy, evaluatePolicy } from '@safebrowse/shared';
import { blockIpcServer } from './block-ipc';
import { BlockExperienceContext } from './dns-proxy';
import { AccessRequestResolutionEvent } from './sync-client';

export interface ActiveChildContext {
  childId: string | null;
  childName: string | null;
}

export interface RequestStatusEntry {
  requestId: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED';
  domain: string;
  expiresAt?: string;
  duration?: number;
  updatedAt: number;
}

export function escapeHtml(str: string): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function formatFriendlyReason(rawReason: string): string {
  if (!rawReason) {
    return 'This site has been restricted by your family protection settings.';
  }

  const upper = rawReason.trim().toUpperCase();

  if (
    upper === 'PAUSED_INTERNET' ||
    upper === 'DINNER_TIME' ||
    upper === 'PAUSED' ||
    upper.includes('PAUSE') ||
    upper.includes('DINNER')
  ) {
    return 'Internet is paused for family time.';
  }
  if (upper === 'BEDTIME_RESTRICTION') {
    return 'Bedtime rule active. Internet access is paused until morning.';
  }
  if (
    upper === 'BEDTIME_ACTIVE' ||
    upper.includes('BEDTIME') ||
    upper.includes('CURFEW')
  ) {
    return 'Bedtime restrictions are active.';
  }
  if (upper === 'ADULT_CONTENT' || upper.includes('ADULT')) {
    return 'This website has content that is not suitable for children.';
  }
  if (upper === 'GAMBLING') {
    return 'Gambling websites are blocked to keep you safe.';
  }
  if (upper === 'MALWARE_SECURITY' || upper.includes('MALWARE') || upper.includes('SECURITY')) {
    return 'This website was blocked because it may harm your computer.';
  }
  if (upper === 'GAMES' || upper.includes('GAMING') || upper.includes('GAME')) {
    return 'Gaming time is currently restricted by your family protection settings.';
  }
  if (upper === 'SOCIAL_MEDIA' || upper.includes('SOCIAL')) {
    return 'Social media websites are restricted by your family protection settings.';
  }
  if (upper === 'STUDY_MODE') {
    return 'Study Mode is active. Only educational websites are permitted right now.';
  }
  if (upper.includes('PARENT') || upper.includes('BLACKLIST') || upper.includes('BLOCK') || upper === 'CUSTOM_RULE') {
    return 'Blocked by your parent in family rules.';
  }

  // If already a human sentence, sanitize and return
  if (!upper.includes('_') && rawReason.length > 5) {
    return rawReason;
  }

  return 'This site has been restricted by your family protection settings.';
}

export class BlockPageServer {
  private server: http.Server | null = null;
  private redirectServer: http.Server | null = null;
  private backendUrl: string;
  private defaultChildId: string | null;
  private deviceId: string;
  private deviceToken: string;
  private activeChildProvider?: () => ActiveChildContext;
  private port: number = 8880;

  private lastTriggeredTimes: Map<string, number> = new Map();
  public lastTriggeredExperience: { domain: string; reason: string; timestamp: number } | null = null;
  private onBlockExperienceCallback?: (domain: string, reason: string) => void;

  private policyProvider?: () => Policy | null;
  private resolutionMap: Map<string, RequestStatusEntry> = new Map();
  private readonly maxResolutionEntries = 100;
  private readonly resolutionTtlMs = 60 * 60 * 1000; // 1 hour

  constructor(
    backendUrl: string,
    defaultChildId: string | null,
    deviceId: string,
    activeChildProvider?: () => ActiveChildContext,
    deviceToken: string = ''
  ) {
    this.backendUrl = backendUrl;
    this.defaultChildId = defaultChildId;
    this.deviceId = deviceId;
    this.deviceToken = deviceToken;
    this.activeChildProvider = activeChildProvider;
  }

  public setActiveChildProvider(provider: () => ActiveChildContext): void {
    this.activeChildProvider = provider;
  }

  public setPolicyProvider(provider: () => Policy | null): void {
    this.policyProvider = provider;
  }

  public setOnBlockExperience(cb: (domain: string, reason: string) => void): void {
    this.onBlockExperienceCallback = cb;
  }

  public recordPendingRequest(requestId: string, domain: string): void {
    this.cleanExpiredResolutions();
    this.resolutionMap.set(requestId, {
      requestId,
      status: 'PENDING',
      domain,
      updatedAt: Date.now(),
    });
  }

  public handleAccessRequestResolved(event: AccessRequestResolutionEvent): void {
    this.cleanExpiredResolutions();
    if (event.requestId) {
      const existing = this.resolutionMap.get(event.requestId);
      this.resolutionMap.set(event.requestId, {
        requestId: event.requestId,
        status: event.status,
        domain: event.domain || existing?.domain || '',
        expiresAt: event.expiresAt || existing?.expiresAt,
        duration: event.resolvedDuration || existing?.duration,
        updatedAt: Date.now(),
      });
    } else if (event.domain) {
      for (const entry of this.resolutionMap.values()) {
        if (entry.domain.toLowerCase() === event.domain.toLowerCase()) {
          entry.status = event.status;
          entry.expiresAt = event.expiresAt;
          entry.duration = event.resolvedDuration;
          entry.updatedAt = Date.now();
        }
      }
    }
  }

  private cleanExpiredResolutions(): void {
    const now = Date.now();
    for (const [id, entry] of this.resolutionMap.entries()) {
      if (now - entry.updatedAt > this.resolutionTtlMs) {
        this.resolutionMap.delete(id);
      }
    }
    if (this.resolutionMap.size > this.maxResolutionEntries) {
      const oldestKeys = Array.from(this.resolutionMap.keys()).slice(
        0,
        this.resolutionMap.size - this.maxResolutionEntries
      );
      for (const k of oldestKeys) {
        this.resolutionMap.delete(k);
      }
    }
  }

  public getRequestStatus(requestId?: string, queryDomain?: string): {
    status: 'PENDING' | 'APPROVED' | 'DENIED';
    domain: string;
    expiresAt?: string;
    allowed: boolean;
    duration?: number;
  } {
    let entry = requestId ? this.resolutionMap.get(requestId) : undefined;
    if (!entry && queryDomain) {
      for (const item of this.resolutionMap.values()) {
        if (item.domain.toLowerCase() === queryDomain.toLowerCase()) {
          entry = item;
          break;
        }
      }
    }

    let allowed = false;
    let currentStatus: 'PENDING' | 'APPROVED' | 'DENIED' = entry?.status || 'PENDING';
    const evalDomain = queryDomain || entry?.domain || '';

    // Resilience fallback: evaluate active policy against evalDomain directly
    if (evalDomain && this.policyProvider) {
      try {
        const currentPolicy = this.policyProvider();
        if (currentPolicy) {
          const evalResult = evaluatePolicy(currentPolicy, evalDomain);
          if (
            evalResult.action === 'ALLOW' &&
            (evalResult.reason === 'TEMPORARY_ALLOW' ||
              evalResult.reason === 'EXPLICIT_ALLOW' ||
              evalResult.reason === 'ESSENTIAL_ALLOW')
          ) {
            allowed = true;
            currentStatus = 'APPROVED';
          }
        }
      } catch {}
    }

    if (currentStatus === 'APPROVED') {
      allowed = true;
    }

    return {
      status: currentStatus,
      domain: evalDomain,
      expiresAt: entry?.expiresAt,
      allowed,
      duration: entry?.duration || 15,
    };
  }

  /**
   * Triggers the child-visible SafeBrowse block experience outside of TLS/HTTPS interception.
   * Dispatches the event via authenticated local IPC to the SafeBrowse User-Session Helper
   * running in the logged-in interactive child's desktop session.
   */
  public triggerBlockExperience(
    target: string | BlockExperienceContext,
    reason?: string
  ): { sent: boolean; reason: string; url?: string } {
    const now = Date.now();
    let requestedDomain: string;
    let approvalDomain: string;
    let finalReason: string;

    if (typeof target === 'string') {
      requestedDomain = target;
      approvalDomain = target;
      finalReason = reason || 'Blocked by family rules';
    } else {
      requestedDomain = target.requestedDomain;
      approvalDomain = target.approvalDomain || target.requestedDomain;
      finalReason = target.reason || reason || 'Blocked by family rules';
    }

    this.lastTriggeredExperience = { domain: requestedDomain, reason: finalReason, timestamp: now };

    if (this.onBlockExperienceCallback) {
      this.onBlockExperienceCallback(requestedDomain, finalReason);
    }

    // Delegate presentation to User Session Helper via authenticated local IPC
    return blockIpcServer.presentBlock(
      {
        requestedDomain,
        approvalDomain,
        reason: finalReason,
      },
      undefined,
      this.port
    );
  }

  public start(port: number = 8880): Promise<void> {
    this.port = port;
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        const parsed = url.parse(req.url || '', true);

        // Status Polling Endpoint for Parent Approval
        if (parsed.pathname === '/request-status' && req.method === 'GET') {
          const reqId = (parsed.query.id as string) || '';
          const qDomain = (parsed.query.domain as string) || '';
          const statusResult = this.getRequestStatus(reqId, qDomain);

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          });
          res.end(JSON.stringify(statusResult));
          return;
        }

        if (parsed.pathname === '/submit-request' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              const active = this.activeChildProvider ? this.activeChildProvider() : null;
              const targetChildId = active?.childId || data.childId || this.defaultChildId;

              const response = await fetch(`${this.backendUrl}/api/requests`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-device-id': this.deviceId,
                  'x-device-token': this.deviceToken,
                },
                body: JSON.stringify({
                  childId: targetChildId,
                  deviceId: this.deviceId,
                  domain: data.domain,
                  reason: data.reason || 'Child requested access to website',
                }),
              });

              if (response.ok) {
                const respData = await response.json().catch(() => ({}));
                const requestId = respData.id || respData.requestId || '';
                const respDomain = respData.domain || data.domain;

                if (requestId) {
                  this.recordPendingRequest(requestId, respDomain);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    success: true,
                    requestId,
                    domain: respDomain,
                  })
                );
              } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to submit request' }));
              }
            } catch (e: any) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'SafeBrowse cloud service is temporarily unreachable. Please ask your parent directly.',
                  offline: true,
                })
              );
            }
          });
          return;
        }

        // Render Block Landing Page (/ or /blocked)
        const rawRequestedDomain = (parsed.query.domain as string) || 'This website';
        const rawApprovalDomain = (parsed.query.approvalDomain as string) || rawRequestedDomain;
        const rawReason = (parsed.query.reason as string) || '';
        const active = this.activeChildProvider ? this.activeChildProvider() : null;
        const profileDisplay = active?.childName || 'Child';

        const safeRequestedDomain = escapeHtml(rawRequestedDomain);
        const safeApprovalDomain = escapeHtml(rawApprovalDomain);
        const friendlyReason = escapeHtml(formatFriendlyReason(rawReason));
        const safeProfile = escapeHtml(profileDisplay);

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SafeBrowse — Access Restricted</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: radial-gradient(circle at 50% 20%, #1e1b4b 0%, #09090b 100%);
      color: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 24px;
      box-sizing: border-box;
    }
    .card {
      background: rgba(17, 24, 39, 0.95);
      border: 1px solid rgba(239, 68, 68, 0.35);
      border-radius: 28px;
      padding: 44px 36px;
      max-width: 520px;
      width: 100%;
      text-align: center;
      box-shadow: 0 25px 60px -15px rgba(0, 0, 0, 0.7), 0 0 40px rgba(239, 68, 68, 0.1);
      backdrop-filter: blur(16px);
    }
    .shield-icon {
      width: 68px;
      height: 68px;
      margin: 0 auto 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(239, 68, 68, 0.15);
      border: 2px solid rgba(239, 68, 68, 0.4);
      border-radius: 20px;
      color: #f87171;
    }
    .brand-title {
      font-size: 13px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: #fca5a5;
      margin-bottom: 8px;
    }
    .profile-pill {
      display: inline-block;
      font-size: 12px;
      font-weight: 700;
      color: #93c5fd;
      background: rgba(59, 130, 246, 0.15);
      padding: 4px 12px;
      border-radius: 12px;
      margin-bottom: 20px;
    }
    h1 {
      font-size: 26px;
      font-weight: 800;
      margin: 0 0 12px 0;
      letter-spacing: -0.5px;
      color: #ffffff;
    }
    .domain-target {
      color: #f87171;
      font-family: monospace;
      font-size: 16px;
      font-weight: 700;
      word-break: break-all;
    }
    .subtitle-msg {
      font-size: 14px;
      color: #94a3b8;
      margin: 8px 0 20px 0;
      line-height: 1.4;
    }
    .reason-box {
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid #334155;
      border-radius: 16px;
      padding: 16px;
      margin: 0 0 28px;
      font-size: 14px;
      line-height: 1.5;
      color: #cbd5e1;
      text-align: left;
    }
    .reason-title {
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #94a3b8;
      margin-bottom: 6px;
    }
    .button-group {
      display: flex;
      gap: 12px;
      margin-top: 10px;
    }
    .btn {
      flex: 1;
      border: none;
      border-radius: 16px;
      padding: 14px 20px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
    }
    .btn-secondary {
      background: #1e293b;
      color: #e2e8f0;
      border: 1px solid #475569;
    }
    .btn-secondary:hover {
      background: #334155;
      color: #ffffff;
    }
    .btn-primary {
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
      color: #ffffff;
      box-shadow: 0 10px 20px -5px rgba(37, 99, 235, 0.4);
    }
    .btn-primary:hover {
      background: linear-gradient(135deg, #1d4ed8, #1e40af);
      transform: translateY(-1px);
    }
    .footer-brand {
      margin-top: 24px;
      font-size: 12px;
      font-weight: 600;
      color: #64748b;
      letter-spacing: 0.5px;
    }
    .form-group {
      display: none;
      margin-top: 20px;
      text-align: left;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      padding: 12px 16px;
      border-radius: 14px;
      background: #0f172a;
      border: 1px solid #334155;
      color: white;
      font-size: 13px;
      margin-bottom: 12px;
    }
    input:focus { outline: 2px solid #3b82f6; }
    .status-card {
      display: none;
      border-radius: 20px;
      padding: 24px 20px;
      margin-top: 20px;
      text-align: center;
      animation: fadeIn 0.3s ease;
    }
    .status-pending {
      background: rgba(30, 58, 138, 0.25);
      border: 1px solid rgba(59, 130, 246, 0.4);
      color: #93c5fd;
    }
    .status-approved {
      background: rgba(22, 101, 52, 0.25);
      border: 1px solid rgba(34, 197, 94, 0.4);
      color: #86efac;
    }
    .status-denied {
      background: rgba(153, 27, 27, 0.25);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #fca5a5;
    }
    .spinner {
      display: inline-block;
      width: 28px;
      height: 28px;
      border: 3px solid rgba(147, 197, 253, 0.3);
      border-radius: 50%;
      border-top-color: #60a5fa;
      animation: spin 1s ease-in-out infinite;
      margin-bottom: 12px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="shield-icon">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
    </div>

    <div class="brand-title">SafeBrowse</div>
    <div><span class="profile-pill">Profile: ${safeProfile}</span></div>

    <h1>This site is blocked</h1>
    <div class="domain-target">${safeApprovalDomain}</div>
    ${rawRequestedDomain.toLowerCase() !== rawApprovalDomain.toLowerCase() ? `<div style="font-size: 11px; color: #64748b; margin-top: 4px; font-family: monospace;">Requested: ${safeRequestedDomain}</div>` : ''}
    <div class="subtitle-msg">This site has been restricted by your family protection settings.</div>

    <div class="reason-box">
      <div class="reason-title">Reason:</div>
      <div>${friendlyReason}</div>
    </div>

    <div class="button-group" id="mainActions">
      <button class="btn btn-secondary" onclick="goBack()">
        ← Go Back
      </button>
      <button class="btn btn-primary" id="askBtn" onclick="openAskForm()">
        Ask Parent
      </button>
    </div>

    <div id="askForm" class="form-group">
      <label style="font-size: 12px; font-weight: 700; color: #cbd5e1; display: block; margin-bottom: 8px;">
        Why do you need access? (Optional)
      </label>
      <input type="text" id="reasonInput" placeholder="e.g. Need this for homework or study">
      <div style="display: flex; gap: 8px;">
        <button class="btn btn-secondary" style="flex: 1;" onclick="cancelAskForm()">Cancel</button>
        <button class="btn btn-primary" id="sendRequestBtn" style="flex: 2;" onclick="submitRequest()">Send Request</button>
      </div>
    </div>

    <div id="pendingStatus" class="status-card status-pending">
      <div class="spinner"></div>
      <div style="font-weight: 800; font-size: 16px; margin-bottom: 6px; color: #ffffff;">Request sent to your parent.</div>
      <div style="font-size: 13px; color: #cbd5e1;">Waiting for parent approval...</div>
    </div>

    <div id="approvedStatus" class="status-card status-approved">
      <div style="font-size: 32px; margin-bottom: 8px;">✓</div>
      <div style="font-weight: 800; font-size: 18px; margin-bottom: 6px; color: #ffffff;">Approved by your parent</div>
      <div style="font-size: 13px; color: #cbd5e1; margin-bottom: 18px;">
        Access is available for: <span id="approvedDuration" style="font-weight: 700; color: #86efac;">15 minutes</span>
      </div>
      <button class="btn btn-primary" id="continueBtn" style="background: linear-gradient(135deg, #16a34a, #15803d); width: 100%;">
        Continue to website
      </button>
    </div>

    <div id="deniedStatus" class="status-card status-denied">
      <div style="font-size: 32px; margin-bottom: 8px;">✕</div>
      <div style="font-weight: 800; font-size: 18px; margin-bottom: 6px; color: #ffffff;">Request declined by your parent.</div>
      <div style="font-size: 13px; color: #cbd5e1; margin-bottom: 18px;">
        Your parent decided not to approve access at this time.
      </div>
      <button class="btn btn-secondary" style="width: 100%;" onclick="goBack()">
        ← Go Back
      </button>
    </div>

    <div class="footer-brand">Protected by SafeBrowse</div>
  </div>

  <script>
    const REQUESTED_DOMAIN = ${JSON.stringify(rawRequestedDomain)};
    const APPROVAL_DOMAIN = ${JSON.stringify(rawApprovalDomain)};
    const TARGET_DOMAIN = APPROVAL_DOMAIN;

    let pollTimer = null;
    let currentRequestId = '';

    function getSafeContinueUrl(domain) {
      if (!domain) return 'https://google.com';
      let clean = String(domain).trim().toLowerCase();
      if (clean.startsWith('*.')) {
        clean = clean.substring(2);
      } else if (clean.startsWith('.')) {
        clean = clean.substring(1);
      }
      clean = clean.replace(/[^a-z0-9.-]/g, '');
      if (!clean || clean.indexOf('.') === -1) {
        return 'https://google.com';
      }
      return 'https://' + clean;
    }

    function goBack() {
      if (window.history.length > 1) {
        window.history.back();
      } else {
        window.location.href = 'https://www.google.com';
      }
    }

    function openAskForm() {
      document.getElementById('mainActions').style.display = 'none';
      document.getElementById('askForm').style.display = 'block';
      document.getElementById('reasonInput').focus();
    }

    function cancelAskForm() {
      document.getElementById('askForm').style.display = 'none';
      document.getElementById('mainActions').style.display = 'flex';
    }

    async function submitRequest() {
      const btn = document.getElementById('sendRequestBtn');
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = 'Sending...';

      const reason = document.getElementById('reasonInput').value.trim();
      try {
        const res = await fetch('/submit-request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: APPROVAL_DOMAIN, reason: reason })
        });
        const respData = await res.json().catch(function() { return {}; });
        if (res.ok) {
          currentRequestId = respData.requestId || '';
          document.getElementById('askForm').style.display = 'none';
          document.getElementById('pendingStatus').style.display = 'block';
          startStatusPolling();
        } else {
          btn.disabled = false;
          btn.textContent = 'Send Request';
          alert(respData.error || 'SafeBrowse service is temporarily unreachable. Please ask your parent directly.');
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Send Request';
        alert('SafeBrowse service is temporarily unreachable. Please ask your parent directly.');
      }
    }

    function startStatusPolling() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(checkRequestStatus, 1500);
    }

    async function checkRequestStatus() {
      try {
        const url = '/request-status?id=' + encodeURIComponent(currentRequestId) + '&domain=' + encodeURIComponent(APPROVAL_DOMAIN);
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();

        if (data.allowed || data.status === 'APPROVED') {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          showApprovedState(data);
        } else if (data.status === 'DENIED') {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          showDeniedState();
        }
      } catch (e) {}
    }

    function showApprovedState(data) {
      document.getElementById('pendingStatus').style.display = 'none';
      document.getElementById('approvedStatus').style.display = 'block';
      const dur = data.duration || 15;
      document.getElementById('approvedDuration').textContent = dur + ' minutes';

      const continueUrl = getSafeContinueUrl(APPROVAL_DOMAIN);
      document.getElementById('continueBtn').onclick = function() {
        window.location.href = continueUrl;
      };

      setTimeout(function() {
        window.location.href = continueUrl;
      }, 1500);
    }

    function showDeniedState() {
      document.getElementById('pendingStatus').style.display = 'none';
      document.getElementById('deniedStatus').style.display = 'block';
    }
  </script>
</body>
</html>`;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      });

      this.server.listen(port, '127.0.0.1', () => {
        console.log(`[Agent] Local Block Landing Server running on http://127.0.0.1:${port}`);
        resolve();
      });

      // Optional Port 80 HTTP Redirector for plain unencrypted HTTP requests
      try {
        this.redirectServer = http.createServer((req, res) => {
          const hostHeader = req.headers.host || '';
          const hostOnly = hostHeader.split(':')[0];
          res.writeHead(302, {
            Location: `http://127.0.0.1:${port}/blocked?domain=${encodeURIComponent(hostOnly)}&reason=Blocked%20by%20family%20rules`,
          });
          res.end();
        });
        this.redirectServer.on('error', () => {
          // Port 80 busy or requires elevated privileges; graceful fallback
        });
        this.redirectServer.listen(80, '127.0.0.1');
      } catch (e) {}
    });
  }

  public stop(): void {
    try {
      this.server?.close();
    } catch {}
    try {
      this.redirectServer?.close();
    } catch {}
  }
}
