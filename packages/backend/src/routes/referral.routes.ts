import { Router, Request, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../db/prisma';
import { nanoid } from 'nanoid';

const router = Router();

// GET /api/referrals - Get user's referral info
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    let ref = await prisma.referral.findFirst({
      where: { referrerUserId: authReq.userId! },
    });

    if (!ref) {
      ref = await prisma.referral.create({
        data: {
          id: `ref-${nanoid(10)}`,
          referrerUserId: authReq.userId!,
          referralCode: `SAFE-${nanoid(6).toUpperCase()}`,
        },
      });
    }

    res.json({
      referralCode: ref.referralCode,
      referralLink: `https://safebrowse.io/r/${ref.referralCode}`,
      totalInvited: ref.referredUserIds.length,
      rewardsEarnedMonths: 0,
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
