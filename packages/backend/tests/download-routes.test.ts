import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { app } from '../src/server';

describe('SafeBrowse Client Download Routes', () => {
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

  it('GET /api/downloads/info returns metadata for Windows and Android packages', async () => {
    const res = await fetch(`${baseUrl}/api/downloads/info`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();

    assert.ok(data.windows);
    assert.strictEqual(data.windows.filename, 'SafeBrowseChild-Pilot.exe');
    assert.strictEqual(data.windows.url, '/api/downloads/windows');
    assert.ok(data.windows.directUrl.includes('SafeBrowseChild-Pilot.exe'));

    assert.ok(data.android);
    assert.strictEqual(data.android.filename, 'safebrowse-child-pilot.apk');
    assert.strictEqual(data.android.url, '/api/downloads/android');
    assert.ok(data.android.directUrl.includes('safebrowse-child-pilot.apk'));
  });

  it('GET /api/downloads/windows responds with file or valid redirect without auth error', async () => {
    // Don't follow redirect so we can inspect status code
    const res = await fetch(`${baseUrl}/api/downloads/windows`, { redirect: 'manual' });
    assert.ok(res.status === 200 || res.status === 302, `Expected 200 or 302 but got ${res.status}`);

    if (res.status === 302) {
      const location = res.headers.get('location');
      assert.ok(location && location.includes('SafeBrowseChild-Pilot.exe'));
    } else {
      const disposition = res.headers.get('content-disposition');
      assert.ok(disposition && disposition.includes('SafeBrowseChild-Pilot.exe'));
    }
  });

  it('GET /api/downloads/android responds with apk or valid redirect without auth error', async () => {
    const res = await fetch(`${baseUrl}/api/downloads/android`, { redirect: 'manual' });
    assert.ok(res.status === 200 || res.status === 302, `Expected 200 or 302 but got ${res.status}`);

    if (res.status === 302) {
      const location = res.headers.get('location');
      assert.ok(location && location.includes('safebrowse-child-pilot.apk'));
    } else {
      const contentType = res.headers.get('content-type');
      assert.ok(contentType && contentType.includes('application/vnd.android.package-archive'));
    }
  });
});
