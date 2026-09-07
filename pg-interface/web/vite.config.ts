import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * The screen, built into `web/dist` and served by the package itself.
 *
 * `base: './'` is what makes it mountable anywhere: the host decides the path — here it is
 * `/admin/embed/database/` — and relative asset URLs resolve against whatever that turns out to be.
 * An absolute base would bake this project's path into the package.
 */
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  plugins: [vue()],
});
