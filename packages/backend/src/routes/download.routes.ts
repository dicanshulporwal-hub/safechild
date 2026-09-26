import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';

export const downloadRouter = Router();

const repoRootDir = path.resolve(__dirname, '../../../..');

const DEFAULT_WINDOWS_RELEASE_URL =
  'https://github.com/dicanshulporwal-hub/safechild/releases/download/v1.0.0-pilot/SafeBrowseChild-Pilot.exe';
const DEFAULT_ANDROID_RELEASE_URL =
  'https://github.com/dicanshulporwal-hub/safechild/releases/download/v1.0.0-pilot/safebrowse-child-pilot.apk';

function findExistingFile(candidatePaths: string[]): string | null {
  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && stat.size > 0) {
          return candidate;
        }
      } catch {}
    }
  }
  return null;
}

// GET /api/downloads/windows -> Download Windows Child Protection Agent
downloadRouter.get('/windows', (req: Request, res: Response) => {
  const candidatePaths = [
    path.join(repoRootDir, 'packages/parent-web/public/downloads/SafeBrowseChild-Pilot.exe'),
    path.join(repoRootDir, 'release/windows/SafeBrowseChild-Pilot.exe'),
    path.join(repoRootDir, 'release/windows/SafeBrowseChild-Pilot.msi'),
    path.join(repoRootDir, 'packages/parent-web/public/downloads/SafeBrowseChild-Pilot.msi'),
    '/opt/safebrowse/downloads/SafeBrowseChild-Pilot.exe',
    '/opt/safebrowse/downloads/SafeBrowseChild-Pilot.msi',
    '/opt/safebrowse/frontend/dist/downloads/SafeBrowseChild-Pilot.exe',
    '/opt/safebrowse/frontend/dist/downloads/SafeBrowseChild-Pilot.msi',
  ];

  const found = findExistingFile(candidatePaths);
  if (found) {
    const filename = path.basename(found);
    return res.download(found, filename);
  }

  const externalUrl = process.env.WINDOWS_DOWNLOAD_URL || DEFAULT_WINDOWS_RELEASE_URL;
  return res.redirect(externalUrl);
});

// GET /api/downloads/android -> Download Android Child Protection APK
downloadRouter.get('/android', (req: Request, res: Response) => {
  const candidatePaths = [
    path.join(repoRootDir, 'packages/parent-web/public/downloads/safebrowse-child-pilot.apk'),
    path.join(repoRootDir, 'release/android/safebrowse-child-pilot.apk'),
    path.join(repoRootDir, 'packages/agent-android/app/build/outputs/apk/debug/app-debug.apk'),
    '/opt/safebrowse/downloads/safebrowse-child-pilot.apk',
    '/opt/safebrowse/frontend/dist/downloads/safebrowse-child-pilot.apk',
  ];

  const found = findExistingFile(candidatePaths);
  if (found) {
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    return res.download(found, 'safebrowse-child-pilot.apk');
  }

  const externalUrl = process.env.ANDROID_DOWNLOAD_URL || DEFAULT_ANDROID_RELEASE_URL;
  return res.redirect(externalUrl);
});

// GET /api/downloads/info -> Metadata about available client downloads
downloadRouter.get('/info', (req: Request, res: Response) => {
  res.json({
    windows: {
      url: '/api/downloads/windows',
      directUrl: DEFAULT_WINDOWS_RELEASE_URL,
      filename: 'SafeBrowseChild-Pilot.exe',
      platform: 'Windows 10 / 11 (64-bit)',
      version: '1.0.0',
    },
    android: {
      url: '/api/downloads/android',
      directUrl: DEFAULT_ANDROID_RELEASE_URL,
      filename: 'safebrowse-child-pilot.apk',
      platform: 'Android 8.0+',
      version: '1.0.0',
    },
  });
});
