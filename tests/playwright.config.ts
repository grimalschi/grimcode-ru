import { defineConfig, devices } from '@playwright/test';

import loadEnv from './src/env.js';

// The browser suite reads the same `.env` as everything else, so it finds the port the stack is on.
loadEnv();

/**
 * The checks that need a real browser.
 *
 * Everything provable with an HTTP request lives in the Vitest suite; this one exists for what
 * only a browser can answer — whether a page throws once its JavaScript runs, whether a theme
 * actually reaches an embedded iframe, and what colour something ends up being.
 */
export default defineConfig({
  testDir: './browser',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.ACCEPTANCE_BASE_URL ?? 'http://127.0.0.1:8080',
    // The admin panel is a desktop surface; the sidebar collapses below this.
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
