import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * The user-facing application.
 *
 * It is served by this module under `/app/`, so the base must match: every asset URL has to
 * survive Router and the browser's own reloads on a deep link.
 */
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, fileURLToPath(new URL('../../..', import.meta.url)), ''), ...process.env };
  const target = `http://127.0.0.1:${env.PORT || 63000}`;
  return {
    // The config lives next to the application it builds, so both the root and the output stay
    // inside `web/` no matter which directory the command was started from.
    root: fileURLToPath(new URL('.', import.meta.url)),
    base: '/app/',
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      proxy: { '^/(?:module/[^/]+/rpc|admin/(?:rpc|csrf)|admin/embed/module/[^/]+/(?:rpc|csrf))(?:/|$|\\?)': target },
    },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});
