import express from 'express';
import cors from 'cors';
import http from 'http';
import { authRouter } from './routes/auth.routes';
import profileRouter from './routes/profile.routes';
import familyRouter from './routes/family.routes';
import referralRouter from './routes/referral.routes';
import { childRouter } from './routes/child.routes';
import { deviceRouter } from './routes/device.routes';
import { policyRouter } from './routes/policy.routes';
import { requestRouter } from './routes/request.routes';
import { activityRouter } from './routes/activity.routes';
import { operationsRouter } from './routes/operations.routes';
import { feedbackRouter } from './routes/feedback.routes';
import { supportRouter } from './routes/support.routes';
import { usageRouter } from './routes/usage.routes';
import { wsManager } from './services/websocket.service';
import { authMiddleware } from './middleware/auth';
import { requireVerifiedEmail } from './middleware/requireVerifiedEmail';
import { mailService } from './services/mail.service';

const app = express();
const port = process.env.PORT || 1002;

// In production, startup must fail securely if required secrets or mail settings are absent or unconfigured
if (process.env.NODE_ENV === 'production') {
  const missing: string[] = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim().length < 32) {
    missing.push('JWT_SECRET (min 32 characters)');
  }
  if (!process.env.MFA_ENCRYPTION_KEY || process.env.MFA_ENCRYPTION_KEY.trim().length < 32) {
    missing.push('MFA_ENCRYPTION_KEY (min 32 characters)');
  }

  // Validate production mail configuration (fails with PRODUCTION_MAIL_PROVIDER_NOT_CONFIGURED if unconfigured)
  try {
    mailService.validateConfiguration();
  } catch (err: any) {
    missing.push(err.message);
  }

  if (missing.length > 0) {
    console.error('FATAL PRODUCTION CONFIGURATION ERROR: The following required environment variables or providers are missing:');
    missing.forEach((m) => console.error(`  - ${m}`));
    console.error('Production startup aborted for security.');
    process.exit(1);
  }
}

app.use(cors({ origin: '*' }));
app.use(express.json());

// API Routes
// Auth & Account Management (Unverified users can manage auth, verification, and sessions)
app.use('/api/auth', authRouter);
app.use('/api/me', profileRouter);

// Product Operations & Device Endpoints (Routers route parent ops through requireVerifiedEmail and device ops through deviceAuthMiddleware)
app.use('/api/children', authMiddleware, requireVerifiedEmail, childRouter);
app.use('/api/devices', deviceRouter);
app.use('/api/policies', policyRouter);
app.use('/api/requests', requestRouter);
app.use('/api/usage', usageRouter);
app.use('/api/activity', activityRouter);
app.use('/api/family', authMiddleware, requireVerifiedEmail, familyRouter);
app.use('/api/referrals', authMiddleware, requireVerifiedEmail, referralRouter);
app.use('/api/operations', authMiddleware, requireVerifiedEmail, operationsRouter);
app.use('/api/feedback', authMiddleware, requireVerifiedEmail, feedbackRouter);
app.use('/api/support', authMiddleware, requireVerifiedEmail, supportRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

const server = http.createServer(app);

if (process.env.NODE_ENV !== 'test' && typeof require !== 'undefined' && require.main === module) {
  // Initialize WebSockets
  wsManager.init(server);

  server.listen(port, () => {
    console.log(`🚀 SafeBrowse Backend API running on http://localhost:${port}`);
    console.log(`📡 SafeBrowse Real-time WebSocket running on ws://localhost:${port}/ws`);
  });
}

export { app, server };
