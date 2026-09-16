import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { prisma } from '../db/prisma';

export async function ensureDemoAccounts(): Promise<void> {
  if (process.env.AUTO_SEED_DEMO === 'false' || process.env.NODE_ENV === 'test') {
    return;
  }

  const salt = bcrypt.genSaltSync(12);
  const defaultPasswordHash = bcrypt.hashSync('Password123!', salt);

  // 1. Seed / Ensure Parent Demo Account
  try {
    const parentEmail = 'parent@safebrowse.io';
    const existingParent = await prisma.user.findUnique({
      where: { email: parentEmail },
      include: { memberships: true },
    });

    if (!existingParent) {
      const userId = `user-${nanoid(10)}`;
      const familyId = `fam-${nanoid(10)}`;
      const memberId = `fm-${nanoid(10)}`;

      await prisma.$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: userId,
            email: parentEmail,
            passwordHash: defaultPasswordHash,
            name: 'Parent User',
            emailVerified: true,
            mfaEnabled: false,
            systemRole: 'USER',
            tokenVersion: 1,
          },
        });

        await tx.family.create({
          data: {
            id: familyId,
            name: 'Parent’s Family',
            ownerUserId: userId,
            requireMfa: false,
            approvalRule: 'OWNER_OR_PARENT',
          },
        });

        await tx.familyMember.create({
          data: {
            id: memberId,
            familyId,
            userId,
            role: 'OWNER',
          },
        });

        const child1Id = `child-${nanoid(10)}`;
        await tx.child.create({
          data: {
            id: child1Id,
            parentId: userId,
            familyId,
            name: 'Alex Miller',
            age: 12,
            avatar: '👦',
          },
        });

        await tx.policy.create({
          data: {
            id: `pol-${nanoid(10)}`,
            childId: child1Id,
            familyId,
            version: 1,
            isPaused: false,
            blockedCategories: ['ADULT_CONTENT', 'GAMBLING', 'MALWARE_SECURITY'],
            safeSearch: {
              googleSafeSearch: true,
              bingSafeSearch: true,
              duckDuckGoSafeSearch: true,
              youtubeRestrictedMode: 'STRICT',
            },
            rules: {
              create: [
                { id: `rule-${nanoid(8)}`, domain: 'tiktok.com', action: 'BLOCK', reason: 'Social media control' },
                { id: `rule-${nanoid(8)}`, domain: 'khanacademy.org', action: 'ALLOW', reason: 'Study platform' },
              ],
            },
          },
        });

        const child2Id = `child-${nanoid(10)}`;
        await tx.child.create({
          data: {
            id: child2Id,
            parentId: userId,
            familyId,
            name: 'Maya Miller',
            age: 9,
            avatar: '👧',
          },
        });

        await tx.policy.create({
          data: {
            id: `pol-${nanoid(10)}`,
            childId: child2Id,
            familyId,
            version: 1,
            isPaused: false,
            blockedCategories: ['ADULT_CONTENT', 'GAMING', 'SOCIAL_MEDIA'],
            safeSearch: {
              googleSafeSearch: true,
              bingSafeSearch: true,
              duckDuckGoSafeSearch: true,
              youtubeRestrictedMode: 'STRICT',
            },
            rules: {
              create: [
                { id: `rule-${nanoid(8)}`, domain: 'youtube.com', action: 'BLOCK', reason: 'Video streaming' },
              ],
            },
          },
        });

        await tx.device.create({
          data: {
            id: `dev-${nanoid(10)}`,
            familyId,
            childId: child1Id,
            parentId: userId,
            name: 'Alex Windows PC',
            platform: 'windows',
            agentVersion: '1.1.0',
            healthStatus: 'healthy',
            healthState: 'PROTECTED',
            ipAddress: '192.168.1.145',
          },
        });

        await tx.device.create({
          data: {
            id: `dev-${nanoid(10)}`,
            familyId,
            childId: child2Id,
            parentId: userId,
            name: 'Maya Galaxy Tab',
            platform: 'android',
            agentVersion: '1.1.0',
            healthStatus: 'healthy',
            healthState: 'PROTECTED',
            ipAddress: '192.168.1.182',
          },
        });
      });
      console.log('[Seed] Auto-created demo parent account: parent@safebrowse.io (Password: Password123!)');
    } else {
      // Self-heal demo account password and verification status if needed
      const isPasswordValid = bcrypt.compareSync('Password123!', existingParent.passwordHash);
      if (!isPasswordValid || !existingParent.emailVerified || existingParent.mfaEnabled) {
        await prisma.user.update({
          where: { id: existingParent.id },
          data: {
            passwordHash: defaultPasswordHash,
            emailVerified: true,
            mfaEnabled: false,
          },
        });
        console.log('[Seed] Re-synchronized demo parent password and verification: parent@safebrowse.io');
      }
    }
  } catch (err: any) {
    console.warn('[Seed] Warning while seeding parent demo user:', err.message);
  }

  // 2. Seed / Ensure Admin Demo Account
  try {
    const adminEmail = 'admin@safebrowse.io';
    const existingAdmin = await prisma.user.findUnique({
      where: { email: adminEmail },
      include: { memberships: true },
    });

    if (!existingAdmin) {
      const adminUserId = `user-${nanoid(10)}`;
      const adminFamilyId = `fam-${nanoid(10)}`;
      const adminMemberId = `fm-${nanoid(10)}`;

      await prisma.$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: adminUserId,
            email: adminEmail,
            passwordHash: defaultPasswordHash,
            name: 'System Administrator',
            emailVerified: true,
            mfaEnabled: false,
            systemRole: 'SYSTEM_ADMIN',
            tokenVersion: 1,
          },
        });

        await tx.family.create({
          data: {
            id: adminFamilyId,
            name: 'Admin’s Family',
            ownerUserId: adminUserId,
            requireMfa: false,
            approvalRule: 'OWNER_OR_PARENT',
          },
        });

        await tx.familyMember.create({
          data: {
            id: adminMemberId,
            familyId: adminFamilyId,
            userId: adminUserId,
            role: 'OWNER',
          },
        });
      });
      console.log('[Seed] Auto-created demo admin account: admin@safebrowse.io (Password: Password123!)');
    } else {
      const isPasswordValid = bcrypt.compareSync('Password123!', existingAdmin.passwordHash);
      if (!isPasswordValid || !existingAdmin.emailVerified || existingAdmin.systemRole !== 'SYSTEM_ADMIN' || existingAdmin.mfaEnabled) {
        await prisma.user.update({
          where: { id: existingAdmin.id },
          data: {
            passwordHash: defaultPasswordHash,
            emailVerified: true,
            mfaEnabled: false,
            systemRole: 'SYSTEM_ADMIN',
          },
        });
        console.log('[Seed] Re-synchronized demo admin password and role: admin@safebrowse.io');
      }
    }
  } catch (err: any) {
    console.warn('[Seed] Warning while seeding admin demo user:', err.message);
  }
}
