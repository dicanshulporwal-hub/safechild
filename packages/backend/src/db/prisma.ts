import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __safebrowsePrisma: PrismaClient | undefined;
}

export const prisma =
  global.__safebrowsePrisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.__safebrowsePrisma = prisma;
}

export class DatabaseConnectionError extends Error {
  constructor(message: string, public readonly cause?: any) {
    super(message);
    this.name = 'DatabaseConnectionError';
  }
}

/**
 * Verify PostgreSQL connectivity and migration state at application startup.
 * Fails fast if DATABASE_URL is missing, unconnectable, or migrations pending.
 */
export async function verifyDatabaseConnection(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || !dbUrl.startsWith('postgres')) {
    throw new DatabaseConnectionError(
      'DATABASE_URL environment variable is required and must be a valid PostgreSQL connection string.'
    );
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err: any) {
    throw new DatabaseConnectionError(
      `Failed to connect to PostgreSQL database: ${err.message}`,
      err
    );
  }

  // In production, ensure migrations have been applied
  if (process.env.NODE_ENV === 'production') {
    try {
      const migrations: any[] = await prisma.$queryRaw`
        SELECT id, migration_name, finished_at 
        FROM "_prisma_migrations" 
        WHERE rolled_back_at IS NULL
      `;
      if (!migrations || migrations.length === 0) {
        throw new Error('No applied database migrations found in _prisma_migrations table.');
      }
    } catch (err: any) {
      throw new DatabaseConnectionError(
        `Production database migration check failed: ${err.message}`,
        err
      );
    }
  }
}

/**
 * Safely reset the test database between test suites or runs.
 * Cleans all application tables in one atomic statement using TRUNCATE ... CASCADE.
 */
export async function resetTestDatabase(): Promise<void> {
  const tableNames = [
    'UserSession',
    'MfaChallenge',
    'FamilyInvitation',
    'PairingCode',
    'AccessRequest',
    'ChildUsageRecord',
    'ActivityEvent',
    'FamilyAuditLog',
    'SystemAuditLog',
    'PasswordResetToken',
    'EmailVerificationToken',
    'Referral',
    'Policy',
    'Device',
    'Child',
    'FamilyMember',
    'Family',
    'User',
  ];

  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tableNames.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE;`
  );
}
