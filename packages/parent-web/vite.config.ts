import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@safebrowse/shared': path.resolve(__dirname, '../shared/src/index.ts'),
      '@safebrowse/protocol': path.resolve(__dirname, '../protocol/src/index.ts'),
    },
  },
  server: {
    port: 1001,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
});
