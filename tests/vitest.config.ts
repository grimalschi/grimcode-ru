import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the HTTP suite. The `browser/` specs are Playwright's and fail to even load here.
    include: ['src/**/*.test.ts'],
    globalSetup: ['./src/env.ts'],
    // These talk to a running stack over HTTP, so they are slower than unit tests and must not run
    // concurrently: several of them change administrator access and would otherwise race.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
