import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The public site is server-rendered.
 *
 * Everything here is public and meant to be indexed, so the HTML has to be complete before any
 * JavaScript runs — a crawler, a link preview and a slow connection all see the finished page.
 */
export default defineConfig({
  publicDir: 'public',
  server: { port: 3000 },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    react(),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
