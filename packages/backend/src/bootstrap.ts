import http from 'http';
import express from 'express';
import { prisma } from './db/prisma';
import { mailService } from './services/mail.service';
import { wsManager } from './services/websocket.service';
import { ensureDemoAccounts } from './services/seed.service';

export interface BootstrapOptions {
  port?: number | string;
  skipListen?: boolean;
}

export async function bootstrap(
  app: express.Application,
  server: http.Server,
  options: BootstrapOptions = {}
): Promise<http.Server> {
  const port = options.port || process.env.PORT || 1002;
  const isProduction = process.env.NODE_ENV === 'production';

  // 1. Validate Environment Variables
  const missing: string[] = [];

  if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.startsWith('postgres')) {
    missing.push('DATABASE_URL (valid PostgreSQL connection string required)');
  }

  if (process.env.STORAGE_MODE && !process.env.STORAGE_MODE.startsWith('postgres')) {
    missing.push('STORAGE_MODE must be postgres (PostgreSQL cutover is mandatory)');
  }

  if (isProduction) {
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim().length < 32) {
      missing.push('JWT_SECRET (min 32 characters in production)');
    }
    if (!process.env.MFA_ENCRYPTION_KEY || process.env.MFA_ENCRYPTION_KEY.trim().length < 32) {
      missing.push('MFA_ENCRYPTION_KEY (min 32 characters in production)');
    }

    try {
      mailService.validateConfiguration();
    } catch (err: any) {
      missing.push(err.message);
    }
  }

  if (missing.length > 0) {
    console.error('FATAL STARTUP CONFIGURATION ERROR: The following requirements are unsatisfied:');
    missing.forEach((m) => console.error(`  - ${m}`));
    console.error('API startup aborted before opening HTTP port.');
    process.exit(1);
  }

  // 2. PostgreSQL Connectivity Check
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err: any) {
    console.error(`FATAL DATABASE CONNECTION ERROR: Cannot connect to PostgreSQL: ${err.message}`);
    console.error('API startup aborted before opening HTTP port.');
    process.exit(1);
  }

  // 3. PostgreSQL Migration State Check
  try {
    const unapplied: any[] = await prisma.$queryRaw`
      SELECT id, migration_name, finished_at, rolled_back_at 
      FROM _prisma_migrations 
      WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
    `;
    if (unapplied && unapplied.length > 0) {
      console.error('FATAL DATABASE MIGRATION ERROR: Unfinished or rolled-back migrations detected:');
      unapplied.forEach((m) => console.error(`  - ${m.migration_name}`));
      console.error('API startup aborted before opening HTTP port.');
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`FATAL DATABASE MIGRATION STATUS ERROR: ${err.message}`);
    console.error('API startup aborted before opening HTTP port.');
    process.exit(1);
  }

  // 4. PostgreSQL Invariant Verification
  try {
    // Check invariant: exactly one active OWNER per family
    const invalidOwnerCounts: any[] = await prisma.$queryRaw`
      SELECT "familyId", COUNT(*) as cnt
      FROM "FamilyMember"
      WHERE "role" = 'OWNER'::"FamilyRole"
      GROUP BY "familyId"
      HAVING COUNT(*) != 1
    `;
    if (invalidOwnerCounts && invalidOwnerCounts.length > 0) {
      console.error('FATAL INVARIANT VIOLATION: Families with != 1 OWNER detected in database:');
      invalidOwnerCounts.forEach((row) => console.error(`  - Family: ${row.familyId}, Owners: ${row.cnt}`));
      console.error('API startup aborted before opening HTTP port.');
      process.exit(1);
    }

    // Check invariant: Family.ownerUserId matches the active OWNER member
    const ownerMismatches: any[] = await prisma.$queryRaw`
      SELECT f.id, f."ownerUserId", fm."userId" as member_user_id
      FROM "Family" f
      JOIN "FamilyMember" fm ON f.id = fm."familyId" AND fm."role" = 'OWNER'::"FamilyRole"
      WHERE f."ownerUserId" != fm."userId"
    `;
    if (ownerMismatches && ownerMismatches.length > 0) {
      console.error('FATAL INVARIANT VIOLATION: Family.ownerUserId mismatches active OWNER member:');
      ownerMismatches.forEach((row) => console.error(`  - Family: ${row.id}`));
      console.error('API startup aborted before opening HTTP port.');
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`FATAL DATABASE INVARIANT CHECK ERROR: ${err.message}`);
    console.error('API startup aborted before opening HTTP port.');
    process.exit(1);
  }

  // 5. Seed / Self-Heal Demo Accounts
  await ensureDemoAccounts();

  // 6. Initialize WebSockets
  wsManager.init(server);

  // 7. Open HTTP Port
  if (!options.skipListen) {
    await new Promise<void>((resolve) => {
      server.listen(port, () => {
        const address = server.address() as any;
        const actualPort = address?.port || port;
        console.log(`SafeBrowse API Server running on port ${actualPort} [PostgreSQL Single System of Record]`);
        resolve();
      });
    });
  }

  return server;
}
