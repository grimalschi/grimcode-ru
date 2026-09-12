import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * The auth module admin.
 *
 * Served by this module under its protected path, so the base must match: assets have to resolve
 * both inside the Admin shell's iframe and when the protected URL is opened directly.
 */
export default defineConfig(({ command, mode }) => {
  const env = command === 'serve'
    ? { ...loadEnv(mode, fileURLToPath(new URL('../../..', import.meta.url)), ''), ...process.env }
    : process.env;
  const target = `http://127.0.0.1:${env.PORT || 63000}`;
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    base: '/admin/embed/module/auth/',
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      proxy: { '^/(?:module/[^/]+/rpc|admin/(?:rpc|csrf)|admin/embed/module/[^/]+/(?:rpc|csrf))(?:/|$|\\?)': target },
    },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    build: { outDir: 'dist', emptyOutDir: true },
  };
});
