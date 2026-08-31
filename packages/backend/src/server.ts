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

const app = express();
const port = process.env.PORT || 1002;

// In production, startup must fail securely if required secrets are absent or weak
if (process.env.NODE_ENV === 'production') {
  const missing: string[] = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim().length < 32) {
    missing.push('JWT_SECRET (min 32 characters)');
  }
  if (!process.env.MFA_ENCRYPTION_KEY || process.env.MFA_ENCRYPTION_KEY.trim().length < 32) {
    missing.push('MFA_ENCRYPTION_KEY (min 32 characters)');
  }
  if (missing.length > 0) {
    console.error('FATAL PRODUCTION CONFIGURATION ERROR: The following required environment variables are missing or insecure:');
    missing.forEach((m) => console.error(`  - ${m}`));
    console.error('Production startup aborted for security.');
    process.exit(1);
  }
}

app.use(cors({ origin: '*' }));
app.use(express.json());

// API Routes
app.use('/api/auth', authRouter);
app.use('/api/me', profileRouter);
app.use('/api/family', familyRouter);
app.use('/api/referrals', referralRouter);
app.use('/api/children', childRouter);
app.use('/api/devices', deviceRouter);
app.use('/api/policies', policyRouter);
app.use('/api/requests', requestRouter);
app.use('/api/usage', usageRouter);
app.use('/api/activity', activityRouter);
app.use('/api/operations', operationsRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/api/support', supportRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

const server = http.createServer(app);

// Initialize WebSockets
wsManager.init(server);

if (process.env.NODE_ENV !== 'test') {
  server.listen(port, () => {
    console.log(`🚀 SafeBrowse Backend API running on http://localhost:${port}`);
    console.log(`📡 SafeBrowse Real-time WebSocket running on ws://localhost:${port}/ws`);
  });
}

export { app, server };
