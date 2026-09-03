const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const releaseDir = path.resolve(rootDir, 'release');

if (!fs.existsSync(releaseDir)) {
  fs.mkdirSync(releaseDir, { recursive: true });
}

const zipName = 'safebrowse-stage11-step3e-postgres-cutover.zip';
const targetZip = path.join(releaseDir, zipName);
const rootTargetZip = path.join(rootDir, zipName);

console.log('Packaging Stage 11 Step 3E Review Archive...');

// Copy walkthrough.md to workspace root if not already there
const brainWalkthrough = 'C:/Users/acer/.gemini/antigravity/brain/c77c0717-00f8-4bf4-8987-ad7e572fa3ef/walkthrough.md';
if (fs.existsSync(brainWalkthrough)) {
  fs.copyFileSync(brainWalkthrough, path.join(rootDir, 'walkthrough.md'));
}

// Remove old zip files if present
if (fs.existsSync(targetZip)) fs.unlinkSync(targetZip);
if (fs.existsSync(rootTargetZip)) fs.unlinkSync(rootTargetZip);

const psCommand = `
$exclude = @('node_modules', '.git', '.pgdata', 'dist', 'release', '.gemini', '.cache');
$items = Get-ChildItem -Path . | Where-Object { $_.Name -notin $exclude };
Compress-Archive -Path $items.FullName -DestinationPath "${targetZip}" -Force;
Copy-Item "${targetZip}" "${rootTargetZip}" -Force;
`;

execSync(`powershell -NoProfile -Command "${psCommand.replace(/\n/g, ' ')}"`, {
  cwd: rootDir,
  stdio: 'inherit',
});

const stats = fs.statSync(targetZip);
console.log(`✅ Review ZIP successfully created: ${targetZip} (${Math.round(stats.size / 1024)} KB)`);
