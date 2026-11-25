import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = { target: 'http://localhost:4000', changeOrigin: false };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true, proxy: { '/v1': api, '/docs': api } },
  build: { sourcemap: false, target: 'es2022' },
});
