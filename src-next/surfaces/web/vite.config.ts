import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: '../../../dist-next/src-next/surfaces/web-assets', emptyOutDir: true },
});
