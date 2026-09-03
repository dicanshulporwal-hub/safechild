#!/usr/bin/env ts-node

/**
 * SafeBrowse Static Cutover Gate (Stage 11 Step 3E)
 *
 * Verifies that NO production backend code (packages/backend/src and packages/backend/dist/src)
 * imports, references, or contains DataStore, safebrowse-db.json, JSON persistence, or db/store.
 *
 * Zero exemptions exist under packages/backend/src or packages/backend/dist/src.
 *
 * Exits 0 if clean, 1 if any prohibited imports or accesses are found.
 */

import fs from 'fs';
import path from 'path';

const rootDir = path.resolve(__dirname, '..');
const srcDir = path.resolve(rootDir, 'packages/backend/src');
const distDir = path.resolve(rootDir, 'packages/backend/dist/src');

interface Violation {
  file: string;
  line: number;
  content: string;
}

const violations: Violation[] = [];

// Prohibited patterns in production backend code:
const PROHIBITED_PATTERNS = [
  /from\s+['"].*\/db\/store(\.ts|\.js)?['"]/,
  /from\s+['"].*store(\.legacy)?['"]/,
  /require\(['"].*\/db\/store(\.js|\.ts)?['"]\)/,
  /require\(['"].*store(\.legacy)?['"]\)/,
  /\bDataStore\b/,
  /\bsafebrowse-db\.json\b/,
  /STORAGE_MODE\s*===?\s*['"]json['"]/,
  /\bimport\s+.*\bdb\b.*from/,
  /\bdb\.(users|userSessions|families|familyMembers|children|devices|policies|accessRequests|childUsage|activityEvents|familyAuditLogs|systemAuditLogs|passwordResetTokens|emailVerificationTokens|mfaChallenges|referrals|pairingCodes|feedback|supportTickets)\b/,
  /\bdb\.save\(\)/,
  /\bdb\.load\(\)/,
  /\bdb\.runWithLock/,
  /\bdb\.createFamilySnapshot/,
];

function scanDirectory(dir: string) {
  if (!fs.existsSync(dir)) {
    return;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      scanDirectory(fullPath);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.d.ts') || entry.name.endsWith('.map'))) {
      // ZERO exemptions under packages/backend/src or packages/backend/dist/src
      const fileContent = fs.readFileSync(fullPath, 'utf8');
      const lines = fileContent.split('\n');

      lines.forEach((lineText, idx) => {
        const trimmed = lineText.trim();
        // Skip pure comments
        if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
          return;
        }

        for (const pattern of PROHIBITED_PATTERNS) {
          if (pattern.test(lineText)) {
            violations.push({
              file: path.relative(rootDir, fullPath),
              line: idx + 1,
              content: trimmed,
            });
            break;
          }
        }
      });
    }
  }
}

console.log('===============================================================');
console.log('SafeBrowse PostgreSQL Static Cutover Verification');
console.log(`Scanning: ${path.relative(rootDir, srcDir)}`);
if (fs.existsSync(distDir)) {
  console.log(`Scanning: ${path.relative(rootDir, distDir)}`);
}
console.log('===============================================================\n');

scanDirectory(srcDir);
if (fs.existsSync(distDir)) {
  scanDirectory(distDir);
}

if (violations.length > 0) {
  console.error(`❌ Prohibited JSON DataStore references detected in ${violations.length} location(s):`);
  violations.forEach((v) => {
    console.error(`  - ${v.file}:${v.line} -> ${v.content}`);
  });
  console.error('\nFAIL: Production backend code must strictly use PostgreSQL/Prisma without JSON DataStore dependencies.');
  process.exit(1);
} else {
  console.log('✅ Static Cutover Gate PASSED: Zero JSON DataStore imports or usages in production backend source and compiled output.');
  process.exit(0);
}
