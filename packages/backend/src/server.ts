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
import { adminRouter } from './routes/admin.routes';
import { feedbackRouter } from './routes/feedback.routes';
import { supportRouter } from './routes/support.routes';
import { usageRouter } from './routes/usage.routes';
import { authMiddleware } from './middleware/auth';
import { requireVerifiedEmail } from './middleware/requireVerifiedEmail';
import { bootstrap } from './bootstrap';

const app = express();
const port = process.env.PORT || 1002;

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
app.use('/api/admin', adminRouter);
app.use('/api/feedback', authMiddleware, requireVerifiedEmail, feedbackRouter);
app.use('/api/support', authMiddleware, requireVerifiedEmail, supportRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

const server = http.createServer(app);

if (typeof require !== 'undefined' && require.main === module) {
  bootstrap(app, server, { port }).catch((err) => {
    console.error(`FATAL BOOTSTRAP FAILURE: ${err.message}`);
    process.exit(1);
  });
}

export { app, server, bootstrap };
