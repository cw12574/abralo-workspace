import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  css: { postcss: { plugins: [] } },
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5178, proxy: { '/api': 'http://127.0.0.1:4317' } },
});
