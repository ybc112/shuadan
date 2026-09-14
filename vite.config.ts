import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
  server: { hmr: { port: 4319, host: '127.0.0.1' } },
});
