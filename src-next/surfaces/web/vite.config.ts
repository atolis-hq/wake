import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: { outDir: '../../../dist-next/src-next/surfaces/web-assets', emptyOutDir: true },
});
