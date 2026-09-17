#!/usr/bin/env node

/**
 * Portable Cross-Platform Test Runner for SafeBrowse Backend
 *
 * Reliably discovers and executes Node.js test suites across Ubuntu/Linux and Windows
 * while strictly enforcing that integration and destructive tests target only TEST_DATABASE_URL.
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { URL } = require('url');

const backendDir = path.resolve(__dirname, '..');
const repoRootDir = path.resolve(backendDir, '../..');

// 1. Locate and load root .env if present
const envFile = path.join(repoRootDir, '.env');
if (fs.existsSync(envFile)) {
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envFile);
    } catch (err) {
      console.error(`[TestDatabaseGuard] FATAL: Failed to parse .env file at ${envFile}: ${err.message}`);
      process.exit(1);
    }
  }
}

// 2. Strict Fail-Secure TEST_DATABASE_URL retrieval (zero hardcoded fallback)
const rawTestDbUrl = process.env.TEST_DATABASE_URL;
if (!rawTestDbUrl || typeof rawTestDbUrl !== 'string' || rawTestDbUrl.trim().length === 0) {
  console.error('[TestDatabaseGuard] FATAL: TEST_DATABASE_URL is required and must not be empty. Never fallback to DATABASE_URL or default credentials in test harnesses.');
  process.exit(1);
}

const trimmedTestDbUrl = rawTestDbUrl.trim();

// 3. Comprehensive Validation (prefer canonical guard if compiled, otherwise fallback with identical rigor)
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

function validateTestDatabaseUrlFallback(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new Error('TEST_DATABASE_URL is required and must not be empty. Never fallback to DATABASE_URL in test harnesses.');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (err) {
    throw new Error(`Invalid test database connection URL format: ${err.message}`);
  }

  // 1. Protocol check
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`Invalid test database protocol: "${parsed.protocol}". Expected "postgresql:" or "postgres:".`);
  }

  const hostname = (parsed.hostname || '').toLowerCase();
  const dbName = (parsed.pathname || '').replace(/^\/+/, '').split('?')[0];

  // 2. Reject prohibited host patterns
  for (const pattern of PROHIBITED_HOST_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new Error(`Rejected production/cloud database host: "${hostname}". Test suites must never connect to external infrastructure.`);
    }
  }

  // 3. Allowed host check
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new Error(`Disallowed test database host: "${hostname}". Allowed test hosts are: localhost, 127.0.0.1, postgres-test, [::1].`);
  }

  // 4. Prohibited database names
  if (PROHIBITED_DATABASE_NAMES.has(dbName.toLowerCase())) {
    throw new Error(`Rejected production database name: "${dbName}". Test harness cannot target production database names.`);
  }

  // 5. Test database name pattern check
  if (!dbName.toLowerCase().endsWith('_test')) {
    throw new Error(`Database name "${dbName}" does not end with "_test". Test databases must explicitly use the "_test" suffix (e.g. safebrowse_test).`);
  }

  return {
    hostname,
    port: parseInt(parsed.port || '5432', 10),
    database: dbName,
    url: rawUrl.trim(),
  };
}

let validatedConfig;
try {
  const guardPath = path.join(backendDir, 'dist/src/utils/test-db-guard.js');
  if (fs.existsSync(guardPath)) {
    const { validateTestDatabaseUrl } = require(guardPath);
    validatedConfig = validateTestDatabaseUrl(trimmedTestDbUrl);
  } else {
    validatedConfig = validateTestDatabaseUrlFallback(trimmedTestDbUrl);
  }
} catch (err) {
  const message = err.message || String(err);
  if (message.startsWith('[TestDatabaseGuard]')) {
    console.error(message);
  } else {
    console.error(`[TestDatabaseGuard] FATAL: ${message}`);
  }
  process.exit(1);
}

// 4. Handle --validate-only flag (runs validation without launching test runner or connecting to DB)
const rawArgs = process.argv.slice(2);
if (rawArgs.includes('--validate-only')) {
  console.log(`[TestDatabaseGuard] SUCCESS: Validated test database host=${validatedConfig.hostname} port=${validatedConfig.port} db=${validatedConfig.database}`);
  process.exit(0);
}

// 5. Override DATABASE_URL with the validated TEST_DATABASE_URL only after validation succeeds
const env = {
  ...process.env,
  DATABASE_URL: validatedConfig.url,
  TEST_DATABASE_URL: validatedConfig.url,
  NODE_ENV: 'test',
};

// 6. Resolve target test paths portably across Linux and Windows
// If specific test arguments are passed (e.g. node scripts/run-tests.js dist/tests/postgres-e2e.test.js), use them.
// Otherwise, default to "dist/tests" which Node natively and recursively discovers.
const testTargets = rawArgs.length > 0 ? rawArgs : ['dist/tests'];

const testArgs = ['--test', '--test-concurrency=1', ...testTargets];
const result = spawnSync('node', testArgs, {
  cwd: backendDir,
  env,
  stdio: 'inherit',
});

process.exit(result.status !== null ? result.status : 1);
