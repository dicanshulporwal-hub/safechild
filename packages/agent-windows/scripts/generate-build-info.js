const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let commit = process.env.SAFEBROWSE_BUILD_COMMIT || process.env.BUILD_COMMIT || process.env.GITHUB_SHA || '';
if (!commit) {
  try {
    commit = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (err) {
    commit = 'unknown';
  }
}

const targetPath = path.resolve(__dirname, '../src/build-info.ts');
const content = `// Auto-generated build-info module - DO NOT EDIT MANUALLY
export const BUILD_COMMIT = '${commit}';
export const BUILD_TIMESTAMP = '${new Date().toISOString()}';
`;

fs.writeFileSync(targetPath, content, 'utf8');
console.log(`[build-info] Injected BUILD_COMMIT = ${commit}`);
