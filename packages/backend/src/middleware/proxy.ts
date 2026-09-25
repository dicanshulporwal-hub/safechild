import { Application } from 'express';

/**
 * Configures Express trust proxy setting.
 * Uses the narrowest technically correct trust model.
 *
 * Current topology:
 * Public Internet -> VM1 nginx (192.168.1.x) -> VM2 nginx (127.0.0.1) -> Express (127.0.0.1:3000)
 *
 * - VM2 nginx connects to Express on loopback (127.0.0.1)
 * - VM1 nginx connects to VM2 on private LAN (192.168.1.x, RFC 1918 'uniquelocal')
 *
 * In production, defaulting to 'loopback, uniquelocal' trusts only the local VM2 reverse proxy
 * and the private LAN VM1 edge proxy, safely resolving the actual public client IP
 * while preventing untrusted external clients from spoofing X-Forwarded-For.
 *
 * Configurable via TRUST_PROXY env variable ('false', integer hop count, or custom IP/subnet list).
 */
export function configureTrustProxy(app: Application): void {
  const envTrustProxy = process.env.TRUST_PROXY;
  if (envTrustProxy !== undefined) {
    const trimmed = envTrustProxy.trim();
    if (trimmed === 'false') {
      app.set('trust proxy', false);
    } else if (trimmed === 'true') {
      app.set('trust proxy', true);
    } else if (/^\d+$/.test(trimmed)) {
      app.set('trust proxy', parseInt(trimmed, 10));
    } else {
      app.set('trust proxy', trimmed);
    }
  } else if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 'loopback, uniquelocal');
  } else {
    app.set('trust proxy', false);
  }
}
