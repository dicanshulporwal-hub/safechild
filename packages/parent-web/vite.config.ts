import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => {
  const rootDir = path.resolve(__dirname, '../..');
  // Only load variables explicitly prefixed with 'VITE_' to prevent leaking backend secrets
  // (e.g. DATABASE_URL, JWT_SECRET) or inheriting backend NODE_ENV settings.
  const env = {
    ...loadEnv(mode, rootDir, 'VITE_'),
    ...loadEnv(mode, process.cwd(), 'VITE_'),
    ...process.env,
  };

  // Prevent root .env NODE_ENV=development from contaminating production builds
  delete process.env.VITE_USER_NODE_ENV;
  delete env.VITE_USER_NODE_ENV;
  if (mode === 'production') {
    process.env.NODE_ENV = 'production';
  }

  const host = env.VITE_DEV_HOST || env.VITE_HOST || '127.0.0.1';
  const port = Number(env.VITE_DEV_PORT || env.VITE_PORT || 11001);

  const apiTarget = env.VITE_API_TARGET || 'http://127.0.0.1:11002';
  const wsTarget = env.VITE_WS_TARGET || (
    apiTarget.startsWith('https://')
      ? apiTarget.replace(/^https:\/\//, 'wss://')
      : apiTarget.startsWith('http://')
        ? apiTarget.replace(/^http:\/\//, 'ws://')
        : 'ws://127.0.0.1:11002'
  );

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@safebrowse/shared': path.resolve(__dirname, '../shared/src/index.ts'),
        '@safebrowse/protocol': path.resolve(__dirname, '../protocol/src/index.ts'),
      },
    },
    server: {
      host,
      port,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/ws': {
          target: wsTarget,
          ws: true,
        },
      },
    },
  };
});

