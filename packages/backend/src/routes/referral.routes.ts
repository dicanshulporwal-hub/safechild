import { Router, Request, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { db, Referral } from '../db/store';
import { nanoid } from 'nanoid';

const router = Router();

// GET /api/referrals - Get user's referral info
router.get('/', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    let ref = Array.from(db.referrals.values()).find((r) => r.referrerUserId === authReq.userId);

    if (!ref) {
      ref = {
        id: `ref-${nanoid(10)}`,
        referrerUserId: authReq.userId!,
        referralCode: `SAFE-${nanoid(6).toUpperCase()}`,
        status: 'PENDING',
        createdAt: new Date().toISOString(),
      };
      db.referrals.set(ref.id, ref);
      db.save();
    }

    const referralsList = Array.from(db.referrals.values()).filter((r) => r.referrerUserId === authReq.userId);
    res.json({
      referralCode: ref.referralCode,
      referralLink: `https://safebrowse.io/r/${ref.referralCode}`,
      totalInvited: referralsList.length - 1 > 0 ? referralsList.length - 1 : 0,
      rewardsEarnedMonths: 0,
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
