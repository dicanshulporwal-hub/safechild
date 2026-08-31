const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const packagesDir = path.join(rootDir, 'packages');

const dirsToClean = [
  path.join(rootDir, 'release'),
  path.join(rootDir, 'dist'),
];

if (fs.existsSync(packagesDir)) {
  const packages = fs.readdirSync(packagesDir);
  for (const pkg of packages) {
    const pkgDist = path.join(packagesDir, pkg, 'dist');
    const pkgBuild = path.join(packagesDir, pkg, 'build');
    dirsToClean.push(pkgDist, pkgBuild);
  }
}

for (const dir of dirsToClean) {
  if (fs.existsSync(dir)) {
    console.log(`Cleaning ${path.relative(rootDir, dir)}...`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('✅ Workspace clean completed.');
