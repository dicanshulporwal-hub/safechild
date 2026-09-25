import cors, { CorsOptions } from 'cors';

/**
 * Resolves list of allowed origins from environment.
 * Production default: strictly 'https://safebrowse.porwal.online' (never '*')
 * Configurable via CORS_ALLOWED_ORIGINS (or fallback to ALLOWED_ORIGINS).
 */
export function resolveAllowedOrigins(): string[] {
  const envOrigins = process.env.CORS_ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS;
  if (envOrigins && envOrigins.trim().length > 0) {
    return envOrigins
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter((o) => o.length > 0);
  }

  if (process.env.NODE_ENV === 'production') {
    return ['https://safebrowse.porwal.online'];
  }

  // Development and test defaults (strictly defined, never wildcard)
  return [
    'https://safebrowse.porwal.online',
    'http://localhost:1001',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:1001',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
  ];
}

/**
 * Creates environment-driven CORS options:
 * - Approved browser origins receive Access-Control-Allow-Origin and credentials
 * - Arbitrary browser origins receive no CORS access headers (blocked by browser)
 * - Requests without an Origin header (Windows agent, mobile agents, curl, health checks) are allowed
 */
export function createCorsOptions(): CorsOptions {
  return {
    origin: (requestOrigin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // 1. Non-browser clients (native desktop/Windows agent, mobile agents, curl, health checks)
      // have no Origin header. Always allow them.
      if (!requestOrigin) {
        return callback(null, true);
      }

      const allowed = resolveAllowedOrigins();
      const normalized = requestOrigin.trim().replace(/\/+$/, '');

      if (allowed.includes(normalized)) {
        return callback(null, true);
      }

      // Arbitrary browser origin rejected: do not return CORS access headers
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Origin',
      'x-device-id',
      'x-device-token',
      'x-admin-bootstrap-secret',
    ],
    maxAge: 86400,
  };
}

export const corsMiddleware = cors(createCorsOptions());
