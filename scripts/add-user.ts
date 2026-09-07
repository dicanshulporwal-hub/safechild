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
