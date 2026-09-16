#!/usr/bin/env ts-node

import fs from 'fs';
import path from 'path';

// Load .env if present
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { prisma } from '../packages/backend/src/db/prisma';

async function main() {
  const email = process.argv[2] || 'parent@safebrowse.io';
  const password = process.argv[3] || 'Password123!';
  const name = process.argv[4] || 'Parent User';
  const systemRole = (process.argv[5] === 'SYSTEM_ADMIN' ? 'SYSTEM_ADMIN' : 'USER') as 'SYSTEM_ADMIN' | 'USER';

  const normalizedEmail = email.toLowerCase().trim();
  const salt = bcrypt.genSaltSync(12);
  const passwordHash = bcrypt.hashSync(password, salt);

  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    include: { memberships: true },
  });

  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        passwordHash,
        emailVerified: true,
        mfaEnabled: false,
        name,
        systemRole,
      },
    });

    if (systemRole === 'USER' && existing.memberships.length > 0) {
      const familyId = existing.memberships[0].familyId;
      let children = await prisma.child.findMany({ where: { familyId } });
      if (children.length === 0) {
        const child1Id = `child-${nanoid(10)}`;
        const c1 = await prisma.child.create({
          data: {
            id: child1Id,
            parentId: existing.id,
            familyId,
            name: 'Alex Miller',
            age: 12,
            avatar: '👦',
          },
        });
        await prisma.policy.create({
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
          },
        });

        const child2Id = `child-${nanoid(10)}`;
        const c2 = await prisma.child.create({
          data: {
            id: child2Id,
            parentId: existing.id,
            familyId,
            name: 'Maya Miller',
            age: 9,
            avatar: '👧',
          },
        });
        await prisma.policy.create({
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
          },
        });
        children = [c1, c2];
        console.log(`   Sample children Alex & Maya created for family ${familyId}`);
      }

      // Ensure devices exist for children
      for (const ch of children) {
        const devCount = await prisma.device.count({ where: { childId: ch.id } });
        if (devCount === 0) {
          const isAlex = ch.name.includes('Alex');
          await prisma.device.create({
            data: {
              id: `dev-${nanoid(10)}`,
              familyId,
              childId: ch.id,
              parentId: existing.id,
              name: isAlex ? 'Alex Windows PC' : 'Maya Galaxy Tab',
              platform: isAlex ? 'windows' : 'android',
              agentVersion: '1.1.0',
              healthStatus: 'healthy',
              healthState: 'PROTECTED',
              ipAddress: isAlex ? '192.168.1.145' : '192.168.1.182',
            },
          });
          console.log(`   Device paired for ${ch.name}`);
        }
      }
    }

    console.log(`\n✅ Updated existing user:`);
    console.log(`   Email: ${normalizedEmail}`);
    console.log(`   Password: ${password}`);
    console.log(`   Name: ${name}`);
    console.log(`   Role: ${systemRole}`);
    console.log(`   Email Verified: true\n`);
    return;
  }

  const userId = `user-${nanoid(10)}`;
  const familyId = `fam-${nanoid(10)}`;
  const memberId = `fm-${nanoid(10)}`;

  await prisma.$transaction(async (tx) => {
    await tx.user.create({
      data: {
        id: userId,
        email: normalizedEmail,
        passwordHash,
        name,
        emailVerified: true,
        mfaEnabled: false,
        systemRole,
        tokenVersion: 1,
      },
    });

    await tx.family.create({
      data: {
        id: familyId,
        name: `${name.split(' ')[0]}’s Family`,
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

    if (systemRole === 'USER') {
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
          rules: {
            create: [
              { id: `rule-${nanoid(8)}`, domain: 'youtube.com', action: 'BLOCK', reason: 'Video streaming' },
            ],
          },
        },
      });
    }
  });

  console.log(`\n🎉 User successfully created and verified in PostgreSQL:`);
  console.log(`   Email: ${normalizedEmail}`);
  console.log(`   Password: ${password}`);
  console.log(`   Name: ${name}`);
  console.log(`   Role: ${systemRole}`);
  console.log(`   Family ID: ${familyId}`);
  console.log(`   Email Verified: true\n`);
}

main()
  .catch((err) => {
    console.error('❌ Failed to add user:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
