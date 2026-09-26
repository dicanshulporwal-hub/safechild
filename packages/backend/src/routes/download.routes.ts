import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';

export const downloadRouter = Router();

const repoRootDir = path.resolve(__dirname, '../../../..');

export const DEFAULT_WINDOWS_RELEASE_URL =
  'https://github.com/dicanshulporwal-hub/safechild/releases/download/v1.0.0-pilot/SafeBrowseChild-Pilot.msi';

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

// GET /api/downloads/windows -> Download Windows Child Protection MSI Installer
downloadRouter.get('/windows', (req: Request, res: Response) => {
  // Candidate paths prioritize the production WiX MSI installer package
  const candidatePaths = [
    '/opt/safebrowse/downloads/SafeBrowseChild-Pilot.msi',
    '/opt/safebrowse/frontend/dist/downloads/SafeBrowseChild-Pilot.msi',
    path.join(repoRootDir, 'release/windows/SafeBrowseChild-Pilot.msi'),
    path.join(repoRootDir, 'packages/parent-web/public/downloads/SafeBrowseChild-Pilot.msi'),
    path.join(repoRootDir, 'packages/parent-web/dist/downloads/SafeBrowseChild-Pilot.msi'),
  ];

  const found = findExistingFile(candidatePaths);
  if (found) {
    const filename = path.basename(found);
    return res.download(found, filename);
  }

  // Fall back to GitHub Release MSI asset URL or environment override
  const externalUrl = process.env.WINDOWS_DOWNLOAD_URL || DEFAULT_WINDOWS_RELEASE_URL;
  return res.redirect(externalUrl);
});

// GET /api/downloads/android -> Android child app is not yet available for public beta
downloadRouter.get('/android', (req: Request, res: Response) => {
  res.status(404).json({
    error: 'Android child app is not yet available for public beta.',
    status: 'unavailable',
    message: 'The SafeBrowse child application is currently available for Windows 10/11 (64-bit). Android support is in development.',
  });
});

// GET /api/downloads/info -> Metadata about available client downloads (Windows only)
downloadRouter.get('/info', (req: Request, res: Response) => {
  res.json({
    windows: {
      url: '/api/downloads/windows',
      directUrl: DEFAULT_WINDOWS_RELEASE_URL,
      filename: 'SafeBrowseChild-Pilot.msi',
      platform: 'Windows 10 / 11 (64-bit)',
      type: 'installer',
      version: '1.0.0',
    },
  });
});
