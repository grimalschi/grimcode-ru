import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
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
  // The framework plugin brings its own React plugin; adding a second one leaves the stylesheet
  // out of the rendered head.
  plugins: [tailwindcss(), tanstackStart()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
