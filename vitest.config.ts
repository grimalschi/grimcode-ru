import { defineConfig } from 'vitest/config';

// Workspace tooling tests; module tests run through turbo.
export default defineConfig({
  test: {
    include: ['*.test.{ts,mjs}'],
  },
});
