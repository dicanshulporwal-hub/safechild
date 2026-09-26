import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { app } from '../src/server';

describe('SafeBrowse Client Download Routes — Windows MSI & Unavailable Android Suite', () => {
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('1. GET /api/downloads/info returns metadata for Windows MSI installer only (no Android)', async () => {
    const res = await fetch(`${baseUrl}/api/downloads/info`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();

    // 1 & 3: Metadata reports MSI installer
    assert.ok(data.windows, 'Expected windows metadata in response');
    assert.strictEqual(data.windows.filename, 'SafeBrowseChild-Pilot.msi');
    assert.strictEqual(data.windows.url, '/api/downloads/windows');
    assert.strictEqual(data.windows.type, 'installer');
    assert.strictEqual(data.windows.platform, 'Windows 10 / 11 (64-bit)');
    assert.ok(data.windows.directUrl.endsWith('SafeBrowseChild-Pilot.msi'));

    // 4: Android is not advertised as available in metadata
    assert.strictEqual(data.android, undefined, 'Android must NOT be advertised in download metadata');

    // 6: No download route or direct URL points to Tailscale
    assert.ok(!data.windows.directUrl.includes('100.88.17.16'), 'Direct URL must not point to Tailscale');
    assert.ok(!data.windows.directUrl.includes('11002'), 'Direct URL must not point to port 11002');
  });

  it('2. GET /api/downloads/windows serves or redirects strictly to MSI (never EXE)', async () => {
    const res = await fetch(`${baseUrl}/api/downloads/windows`, { redirect: 'manual' });
    assert.ok(res.status === 200 || res.status === 302, `Expected 200 or 302 but got ${res.status}`);

    if (res.status === 302) {
      const location = res.headers.get('location') || '';
      assert.ok(location.includes('SafeBrowseChild-Pilot.msi'), `Redirect location must be MSI, got: ${location}`);
      // 7: no Windows public download points to EXE as the installer
      assert.ok(!location.includes('SafeBrowseChild-Pilot.exe'), 'Redirect must not point to EXE');
      // 6: no download route points to Tailscale
      assert.ok(!location.includes('100.88.17.16'), 'Redirect must not point to Tailscale IP');
      assert.ok(location.startsWith('https://'), 'Redirect must be secure HTTPS');
    } else {
      const disposition = res.headers.get('content-disposition') || '';
      assert.ok(disposition.includes('SafeBrowseChild-Pilot.msi'), `Content disposition must be MSI, got: ${disposition}`);
      assert.ok(!disposition.includes('SafeBrowseChild-Pilot.exe'), 'Served file must not be EXE');
    }
  });

  it('3. GET /api/downloads/android returns controlled unavailable response (404 / unavailable)', async () => {
    // 5: unsupported Android download returns controlled unavailable response
    const res = await fetch(`${baseUrl}/api/downloads/android`, { redirect: 'manual' });
    assert.strictEqual(res.status, 404, 'Expected 404 for unavailable Android route');

    const data = await res.json();
    assert.strictEqual(data.status, 'unavailable');
    assert.ok(data.error && data.error.includes('not yet available'), 'Error must communicate unavailable status');
    assert.ok(!JSON.stringify(data).includes('100.88.17.16'), 'Error body must not contain Tailscale references');
  });
});
