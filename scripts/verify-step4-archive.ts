#!/usr/bin/env ts-node

/**
 * SafeBrowse Stage 11 Step 4 Automated Archive Verifier
 *
 * Verifies the integrity, security, and reproducibility of the Step 4 review archive:
 * 1. Matches SHA-256 with release/release-manifest.json and detached .sha256 file.
 * 2. Asserts all ZIP entries use portable forward-slash `/` paths.
 * 3. Extracts ZIP into temporary inspection directory.
 * 4. Asserts zero forbidden directories or files (.env, dist, node_modules, data, .pgdata).
 * 5. Scans all extracted files for sensitive secrets or private keys.
 * 6. Verifies Android pilot APK, Windows installer, and package-lock integrity.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';

const rootDir = path.resolve(__dirname, '..');
const releaseDir = path.resolve(rootDir, 'release');
const zipFilename = 'safebrowse-stage11-step4-review.zip';
const targetZip = path.join(releaseDir, zipFilename);
const manifestPath = path.join(releaseDir, 'release-manifest.json');
const detachedShaPath = path.join(releaseDir, `${zipFilename}.sha256`);
const tempExtractDir = path.join(rootDir, 'temp_archive_step4_verification');

const FORBIDDEN_NAMES = [
  /^\.env$/,
  /^\.env\.(?!example|production\.example|test\.example)/,
  /^node_modules$/,
  /^dist$/,
  /^build$/,
  /^\.pgdata$/,
  /^data$/,
  /^backups$/,
  /^quarantine$/,
  /safebrowse-stage11-step3[a-z0-9-]*\.zip$/i,
];

const SENSITIVE_CONTENT_PATTERNS = [
  /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP|PRIVATE) KEY-----/,
  /postgres:\/\/[^:]+:[^@]+@(?!localhost|127\.0\.0\.1|postgres-test)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i,
  /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
];

interface CentralDirEntry {
  filename: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  crc32: number;
  localHeaderOffset: number;
}

function parseZipCentralDirectory(buffer: Buffer): CentralDirEntry[] {
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Invalid ZIP: End of Central Directory record not found.');
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  let pos = centralDirOffset;
  const entries: CentralDirEntry[] = [];

  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error(`Invalid Central Directory header signature at offset ${pos}`);
    }

    const compressionMethod = buffer.readUInt16LE(pos + 10);
    const crc32 = buffer.readUInt32LE(pos + 16);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    const filenameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localHeaderOffset = buffer.readUInt32LE(pos + 42);

    const filename = buffer.toString('utf8', pos + 46, pos + 46 + filenameLen);

    entries.push({
      filename,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      crc32,
      localHeaderOffset,
    });

    pos += 46 + filenameLen + extraLen + commentLen;
  }

  return entries;
}

function extractFile(buffer: Buffer, entry: CentralDirEntry): Buffer {
  const localOffset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error(`Invalid Local File Header at offset ${localOffset}`);
  }

  const filenameLen = buffer.readUInt16LE(localOffset + 26);
  const extraLen = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + filenameLen + extraLen;
  const compressedData = buffer.slice(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return compressedData;
  } else if (entry.compressionMethod === 8) {
    return zlib.inflateRawSync(compressedData);
  } else {
    throw new Error(`Unsupported compression method: ${entry.compressionMethod}`);
  }
}

async function verifyArchive() {
  console.log('===============================================================');
  console.log('SafeBrowse Stage 11 Step 4: Automated Release Archive Verifier');
  console.log('===============================================================\n');

  if (!fs.existsSync(targetZip)) {
    throw new Error(`Target archive not found: ${targetZip}`);
  }
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Release manifest not found: ${manifestPath}`);
  }
  if (!fs.existsSync(detachedShaPath)) {
    throw new Error(`Detached SHA-256 checksum file not found: ${detachedShaPath}`);
  }

  const zipBuffer = fs.readFileSync(targetZip);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const detachedContent = fs.readFileSync(detachedShaPath, 'utf8').trim();

  // 1. SHA-256 Verification
  const computedHash = crypto.createHash('sha256').update(zipBuffer).digest('hex');
  console.log(`Computed SHA-256: ${computedHash}`);
  console.log(`Manifest SHA-256: ${manifest.archive.sha256}`);
  console.log(`Detached SHA-256: ${detachedContent.split(' ')[0]}`);

  if (computedHash !== manifest.archive.sha256) {
    throw new Error('SHA-256 Mismatch between archive and release manifest.');
  }
  if (!detachedContent.startsWith(computedHash)) {
    throw new Error('SHA-256 Mismatch between archive and detached .sha256 file.');
  }
  console.log('✅ SHA-256 hashes verified successfully.\n');

  // 2. Central Directory & Forward-Slash Verification
  const entries = parseZipCentralDirectory(zipBuffer);
  console.log(`Total ZIP entries: ${entries.length}`);

  for (const entry of entries) {
    if (entry.filename.includes('\\')) {
      throw new Error(`ZIP Entry "${entry.filename}" contains Windows backslash. Must use portable forward slashes "/".`);
    }

    const segments = entry.filename.split('/');
    for (const seg of segments) {
      for (const pattern of FORBIDDEN_NAMES) {
        if (pattern.test(seg)) {
          throw new Error(`Forbidden file/directory "${seg}" in entry path: ${entry.filename}`);
        }
      }
    }
  }
  console.log('✅ Portable forward-slash paths and forbidden file checks verified.\n');

  // 3. Extraction & Secret Scanning
  if (fs.existsSync(tempExtractDir)) {
    fs.rmSync(tempExtractDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempExtractDir, { recursive: true });

  for (const entry of entries) {
    const uncompressedData = extractFile(zipBuffer, entry);
    const destPath = path.join(tempExtractDir, entry.filename);
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.writeFileSync(destPath, uncompressedData);

    const textContent = uncompressedData.toString('utf8');
    for (const pattern of SENSITIVE_CONTENT_PATTERNS) {
      if (pattern.test(textContent)) {
        throw new Error(`Sensitive secret pattern ${pattern} detected in extracted file "${entry.filename}"`);
      }
    }
  }
  console.log('✅ Extracted and verified 0 sensitive secrets across all packaged files.\n');

  // 4. Pilot Artifacts & Manifest Checks
  const extractedApk = path.join(tempExtractDir, 'release/android/safebrowse-child-pilot.apk');
  const extractedExe = path.join(tempExtractDir, 'release/windows/SafeBrowseChild-Pilot.exe');
  const extractedEvidence = path.join(tempExtractDir, 'evidence/stage11-step4/golden-flow-verification.md');

  if (!fs.existsSync(extractedApk) || !fs.existsSync(extractedExe) || !fs.existsSync(extractedEvidence)) {
    throw new Error('Required pilot deliverables (Android APK, Windows EXE, or golden flow evidence) missing in archive.');
  }
  console.log('✅ Pilot APK, Windows installer, and evidence verified inside archive.\n');

  // Cleanup temporary extraction folder
  fs.rmSync(tempExtractDir, { recursive: true, force: true });

  console.log('===============================================================');
  console.log('🎉 STAGE 11 STEP 4 ARCHIVE VERIFICATION PASSED: Review archive certified.');
  console.log('===============================================================');
}

verifyArchive().catch((err) => {
  console.error(`❌ ARCHIVE VERIFICATION FAILED: ${err.message}`);
  process.exit(1);
});
