import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.mjs', 'src/**/*.test.ts'],
  },
});
