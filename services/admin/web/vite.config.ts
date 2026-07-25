import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The central Admin shell.
 *
 * It is served by this service under `/admin/`, so the base must match: every asset URL has to
 * survive Gateway's admin route and the browser's own reloads on a deep link.
 */
export default defineConfig({
  // The config lives next to the application it builds, so both the root and the output stay
  // inside `web/` no matter which directory the command was started from.
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/admin/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
