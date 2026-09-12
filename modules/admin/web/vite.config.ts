import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * The central Admin shell.
 *
 * It is served by this module under `/admin/`, so the base must match: every asset URL has to
 * survive Router's admin route and the browser's own reloads on a deep link.
 */
export default defineConfig(({ command, mode }) => {
  const env = command === 'serve'
    ? { ...loadEnv(mode, fileURLToPath(new URL('../../..', import.meta.url)), ''), ...process.env }
    : process.env;
  const target = `http://127.0.0.1:${env.PORT || 63000}`;
  return {
    // The config lives next to the application it builds, so both the root and the output stay
    // inside `web/` no matter which directory the command was started from.
    root: fileURLToPath(new URL('.', import.meta.url)),
    base: '/admin/',
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      proxy: { '/admin/embed/module': target, '^/(?:module/[^/]+/rpc|admin/(?:rpc|csrf)|admin/embed/module/[^/]+/(?:rpc|csrf))(?:/|$|\\?)': target },
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
