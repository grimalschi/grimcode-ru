import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'web/src/**/*.test.ts'],
          exclude: ['src/**/*.postgres.test.ts'],
        },
      },
      {
        test: {
          name: 'database',
          include: ['src/**/*.postgres.test.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
