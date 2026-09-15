import react from '@vitejs/plugin-react';
import { isBuiltin } from 'node:module';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'wake-browser-boundary',
      enforce: 'pre',
      resolveId(source) {
        if (isBuiltin(source))
          this.error(`Server-only module ${source} reached the browser bundle`);
        return null;
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.WAKE_UI_API_TARGET ?? 'http://127.0.0.1:4317',
        changeOrigin: true,
        cookieDomainRewrite: '',
      },
    },
  },
  build: { outDir: '../../../dist/src/surfaces/web-assets', emptyOutDir: true },
});
