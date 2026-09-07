import { defineConfig } from 'vitest/config';

// Only the entry's own tests: without `include` vitest walks the whole repository and runs every
// package's tests a second time, out of the root, where their `dist` is not built.
export default defineConfig({
  test: {
    include: ['index.test.ts'],
  },
});
