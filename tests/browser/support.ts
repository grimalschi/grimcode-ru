import { expect, type Page } from '@playwright/test';

/**
 * Shared pieces for the browser suite.
 */

export const OWNER_EMAIL = process.env.ACCEPTANCE_OWNER_EMAIL ?? '';
export const OWNER_PASSWORD = process.env.ACCEPTANCE_OWNER_PASSWORD ?? '';

export function requireOwnerCredentials(): void {
  if (OWNER_EMAIL === '' || OWNER_PASSWORD === '') {
    throw new Error(
      'The browser suite needs ACCEPTANCE_OWNER_EMAIL and ACCEPTANCE_OWNER_PASSWORD, ' +
        'which are normally in .env.',
    );
  }
}

/**
 * Signs in through the real form, because that is also how the cookie the rest of the run depends
 * on gets set.
 */
export async function signIn(page: Page): Promise<void> {
  requireOwnerCredentials();

  await page.goto('/app/login');
  await page.getByLabel('Email').fill(OWNER_EMAIL);
  await page.getByLabel('Password').fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.waitForURL((url) => !url.pathname.startsWith('/app/login'));
}

/**
 * A message the browser prints because a protection did its job.
 *
 * The delivery preview is a fully sandboxed frame, and Chromium reports every refusal to run
 * something inside it on the console. Treating that as a failure would mean the stricter the
 * sandbox, the redder the test.
 */
const EXPECTED_CONSOLE = [/Blocked script execution in 'about:srcdoc'/i, /frame is sandboxed/i];

/**
 * Collects everything the page complained about.
 *
 * A production bundle that throws on load still renders something, so a test that only looked at
 * the markup would pass while the interface was broken.
 */
export function collectPageErrors(page: Page): string[] {
  const problems: string[] = [];

  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;

    const text = message.text();
    if (EXPECTED_CONSOLE.some((pattern) => pattern.test(text))) return;

    problems.push(`console: ${text}`);
  });

  return problems;
}

/** Fails with the actual messages rather than a bare count. */
export function expectNoPageErrors(problems: string[]): void {
  expect(problems, problems.join('\n')).toEqual([]);
}

/** The theme the document is actually in, as opposed to the one that was requested. */
export async function appliedTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.dataset.theme ?? null);
}

export async function frameAppliedTheme(page: Page, name: string): Promise<string | null> {
  const frame = page.frameLocator(name);
  return frame.locator('html').getAttribute('data-theme');
}
