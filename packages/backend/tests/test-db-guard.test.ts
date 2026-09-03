import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  validateTestDatabaseUrl,
  TestDatabaseGuardError,
} from '../src/utils/test-db-guard';

describe('SafeBrowse Test Database Safety Guard Unit Tests', () => {
  it('should accept valid localhost test database URL', () => {
    const config = validateTestDatabaseUrl('postgresql://safebrowse:pass@localhost:5432/safebrowse_test');
    assert.strictEqual(config.hostname, 'localhost');
    assert.strictEqual(config.port, 5432);
    assert.strictEqual(config.database, 'safebrowse_test');
  });

  it('should accept valid 127.0.0.1 test database URL', () => {
    const config = validateTestDatabaseUrl('postgres://safebrowse:pass@127.0.0.1:5432/my_custom_test');
    assert.strictEqual(config.hostname, '127.0.0.1');
    assert.strictEqual(config.database, 'my_custom_test');
  });

  it('should accept valid docker container hostname postgres-test', () => {
    const config = validateTestDatabaseUrl('postgresql://safebrowse:pass@postgres-test:5432/safebrowse_test');
    assert.strictEqual(config.hostname, 'postgres-test');
    assert.strictEqual(config.database, 'safebrowse_test');
  });

  it('should reject missing or empty TEST_DATABASE_URL', () => {
    assert.throws(() => validateTestDatabaseUrl(''), {
      name: 'TestDatabaseGuardError',
      message: /TEST_DATABASE_URL is required/,
    });
    assert.throws(() => validateTestDatabaseUrl(undefined), {
      name: 'TestDatabaseGuardError',
      message: /TEST_DATABASE_URL is required/,
    });
  });

  it('should reject non-postgresql protocol', () => {
    assert.throws(() => validateTestDatabaseUrl('mysql://root@localhost:3306/safebrowse_test'), {
      name: 'TestDatabaseGuardError',
      message: /Invalid test database protocol/,
    });
  });

  it('should reject remote / cloud production hostnames', () => {
    assert.throws(
      () => validateTestDatabaseUrl('postgresql://user:secret@safebrowse-prod.rds.amazonaws.com:5432/safebrowse_test'),
      {
        name: 'TestDatabaseGuardError',
        message: /Rejected production\/cloud database host/,
      }
    );
    assert.throws(
      () => validateTestDatabaseUrl('postgresql://user:secret@db.supabase.co:5432/safebrowse_test'),
      {
        name: 'TestDatabaseGuardError',
        message: /Rejected production\/cloud database host/,
      }
    );
    assert.throws(
      () => validateTestDatabaseUrl('postgresql://user:secret@prod.render.com:5432/safebrowse_test'),
      {
        name: 'TestDatabaseGuardError',
        message: /Rejected production\/cloud database host/,
      }
    );
  });

  it('should reject disallowed unapproved remote hosts', () => {
    assert.throws(
      () => validateTestDatabaseUrl('postgresql://user:pass@192.168.1.50:5432/safebrowse_test'),
      {
        name: 'TestDatabaseGuardError',
        message: /Disallowed test database host/,
      }
    );
  });

  it('should reject production database names even on localhost', () => {
    assert.throws(
      () => validateTestDatabaseUrl('postgresql://safebrowse:pass@localhost:5432/safebrowse'),
      {
        name: 'TestDatabaseGuardError',
        message: /Rejected production database name/,
      }
    );
    assert.throws(
      () => validateTestDatabaseUrl('postgresql://safebrowse:pass@127.0.0.1:5432/production'),
      {
        name: 'TestDatabaseGuardError',
        message: /Rejected production database name/,
      }
    );
    assert.throws(
      () => validateTestDatabaseUrl('postgresql://safebrowse:pass@127.0.0.1:5432/postgres'),
      {
        name: 'TestDatabaseGuardError',
        message: /Rejected production database name/,
      }
    );
  });

  it('should reject database names that do not end in _test', () => {
    assert.throws(
      () => validateTestDatabaseUrl('postgresql://safebrowse:pass@localhost:5432/safebrowse_staging'),
      {
        name: 'TestDatabaseGuardError',
        message: /does not end with "_test"/,
      }
    );
  });
});
