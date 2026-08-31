const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const releaseDir = path.join(rootDir, 'release');
const zipFile = path.join(releaseDir, 'safebrowse-stage11-step2-review.zip');

if (!fs.existsSync(releaseDir)) {
  fs.mkdirSync(releaseDir, { recursive: true });
}

const excludeDirs = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'data',
  'backups',
  'logs',
  '.turbo',
  '.cache',
  '.vite',
  '.gradle',
  'release',
]);

const excludeExts = new Set(['.log', '.tsbuildinfo', '.sqlite', '.sqlite3', '.db', '.bak', '.backup', '.snap', '.pfx', '.cer', '.crt', '.key', '.snk', '.jks', '.keystore', '.apk', '.aab']);

function getFiles(dir, fileList = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath);

    if (entry.isDirectory()) {
      if (!excludeDirs.has(entry.name)) {
        getFiles(fullPath, fileList);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (entry.name === '.env' || excludeExts.has(ext)) {
        continue;
      }
      fileList.push(fullPath);
    }
  }
  return fileList;
}

const files = getFiles(rootDir);
console.log(`Found ${files.length} clean source files to package.`);

// Create a temp staging dir
const os = require('os');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_review_'));

try {
  for (const file of files) {
    const rel = path.relative(rootDir, file);
    const target = path.join(tempDir, rel);
    const targetDir = path.dirname(target);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    fs.copyFileSync(file, target);
  }

  // Compress using PowerShell Compress-Archive
  if (fs.existsSync(zipFile)) {
    fs.unlinkSync(zipFile);
  }
  execSync(`powershell -Command "Compress-Archive -Path '${tempDir}\\*' -DestinationPath '${zipFile}' -Force"`, {
    stdio: 'inherit',
  });

  const stat = fs.statSync(zipFile);
  console.log(`✅ Successfully generated review ZIP: ${zipFile} (${(stat.size / 1024).toFixed(1)} KB)`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
