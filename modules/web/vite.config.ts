import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig, loadEnv } from 'vite';

/** One build and router: public pages use SSR, the /app branch renders in the browser. */
export default defineConfig(({ command, mode }) => {
  // loadEnv also changes Vite's NODE_ENV; the application's .env is only needed by the dev server.
  const env = command === 'serve'
    ? { ...loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), ''), ...process.env }
    : process.env;
  const target = `http://127.0.0.1:${env.PORT || 63000}`;

  return {
    publicDir: 'public',
    server: {
      host: '127.0.0.1',
      // Give each worktree a frontend port beside its application port.
      port: Number(env.PORT || 63000) + 100,
      strictPort: true,
      proxy: { '/module/': target },
    },
    // Start brings its own React plugin; adding another one loses stylesheet collection.
    plugins: [tailwindcss(), tanstackStart()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
  };
});
