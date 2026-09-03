/**
 * SafeBrowse Fail-Secure Test Database Safety Guard
 *
 * Enforces strict validation of test database connection strings before
 * any destructive test operation (TRUNCATE, reset, migration, seeding).
 *
 * Rules:
 * - Requires TEST_DATABASE_URL (never falls back to DATABASE_URL in test harnesses).
 * - Allowed hosts: localhost, 127.0.0.1, postgres-test, [::1].
 * - Rejects any remote hosts, cloud providers, and production domain patterns.
 * - Rejects production database names (safebrowse, prod, production, etc.).
 * - Requires database name to end with `_test` (e.g. `safebrowse_test`).
 * - Executes database-level marker verification (`SELECT current_database()`).
 * - Cannot be bypassed by NODE_ENV=test.
 */

import { PrismaClient } from '@prisma/client';
import { URL } from 'url';

export class TestDatabaseGuardError extends Error {
  constructor(message: string) {
    super(`[TestDatabaseGuard] FATAL: ${message}`);
    this.name = 'TestDatabaseGuardError';
  }
}

export interface ParsedTestDatabaseConfig {
  hostname: string;
  port: number;
  database: string;
  url: string;
}

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', 'postgres-test', '[::1]', '::1']);

const PROHIBITED_HOST_PATTERNS = [
  /rds\.amazonaws\.com/i,
  /supabase\.co/i,
  /render\.com/i,
  /cockroachlabs\.cloud/i,
  /neon\.tech/i,
  /azure\.com/i,
  /google\.com/i,
  /digitalocean\.com/i,
  /railway\.app/i,
  /fly\.io/i,
  /heroku\.com/i,
];

const PROHIBITED_DATABASE_NAMES = new Set([
  'safebrowse',
  'production',
  'prod',
  'safebrowse_prod',
  'safebrowse_production',
  'main',
  'master',
  'postgres',
  'defaultdb',
  'primary',
]);

/**
 * Validates that a connection string strictly points to an approved local/containerized test database.
 * Throws TestDatabaseGuardError on any violation.
 */
export function validateTestDatabaseUrl(rawUrl?: string): ParsedTestDatabaseConfig {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new TestDatabaseGuardError(
      'TEST_DATABASE_URL is required and must not be empty. Never fallback to DATABASE_URL in test harnesses.'
    );
  }

  const trimmed = rawUrl.trim();

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (err: any) {
    throw new TestDatabaseGuardError(`Invalid test database connection URL format: ${err.message}`);
  }

  // 1. Protocol check
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new TestDatabaseGuardError(
      `Invalid test database protocol: "${parsed.protocol}". Expected "postgresql:" or "postgres:".`
    );
  }

  const hostname = (parsed.hostname || '').toLowerCase();
  const port = parseInt(parsed.port || '5432', 10);
  const dbName = (parsed.pathname || '').replace(/^\/+/, '').split('?')[0];

  // 2. Reject prohibited host patterns
  for (const pattern of PROHIBITED_HOST_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new TestDatabaseGuardError(
        `Rejected production/cloud database host: "${hostname}". Test suites must never connect to external infrastructure.`
      );
    }
  }

  // 3. Allowed host check
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new TestDatabaseGuardError(
      `Disallowed test database host: "${hostname}". Allowed test hosts are: localhost, 127.0.0.1, postgres-test, [::1].`
    );
  }

  // 4. Prohibited database names
  if (PROHIBITED_DATABASE_NAMES.has(dbName.toLowerCase())) {
    throw new TestDatabaseGuardError(
      `Rejected production database name: "${dbName}". Test harness cannot target production database names.`
    );
  }

  // 5. Test database name pattern check
  if (!dbName.toLowerCase().endsWith('_test')) {
    throw new TestDatabaseGuardError(
      `Database name "${dbName}" does not end with "_test". Test databases must explicitly use the "_test" suffix (e.g. safebrowse_test).`
    );
  }

  return {
    hostname,
    port,
    database: dbName,
    url: trimmed,
  };
}

/**
 * Creates a dedicated PrismaClient strictly bound to TEST_DATABASE_URL.
 */
export function createTestPrismaClient(testDatabaseUrl?: string): PrismaClient {
  const config = validateTestDatabaseUrl(testDatabaseUrl);
  return new PrismaClient({
    datasources: {
      db: {
        url: config.url,
      },
    },
  });
}

/**
 * Executes runtime marker check against live PostgreSQL engine to confirm the connected database
 * is genuinely the approved test database.
 */
export async function assertLiveTestDatabaseMarker(
  client: PrismaClient,
  expectedDbName: string
): Promise<void> {
  const result = await client.$queryRawUnsafe<Array<{ current_database: string }>>(
    'SELECT current_database();'
  );

  if (!result || result.length === 0 || !result[0].current_database) {
    throw new TestDatabaseGuardError('Failed to query current_database() from live PostgreSQL instance.');
  }

  const liveDbName = result[0].current_database;

  if (liveDbName !== expectedDbName || !liveDbName.endsWith('_test')) {
    throw new TestDatabaseGuardError(
      `Live database mismatch! Connected database is "${liveDbName}", expected approved test database "${expectedDbName}". Destructive operations aborted.`
    );
  }
}
