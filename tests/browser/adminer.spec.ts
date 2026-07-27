import { expect, test, type FrameLocator, type Page } from '@playwright/test';

import { signIn } from './support.js';

/**
 * The real Adminer, themed to match the panel around it.
 *
 * The panel's database browser is a third-party PHP application with its own stylesheet, so its
 * theme is not something the admin's CSS can reach into. What is checked here is that the wrapper actually recolours it —
 * on more than the first page, because the overview, a table listing and pagination are styled by
 * different rules and a wrapper that only handles one of them looks finished while it is not.
 */

const DARK_BACKGROUND_MAX = 90;
const LIGHT_BACKGROUND_MIN = 200;

/**
 * Average channel value of the element's own background colour.
 *
 * Read through `expect.poll` by every caller: clicking a link inside Adminer starts a navigation,
 * and a measurement taken while it is in flight fails with a destroyed execution context. Polling
 * retries until the new page is the one being measured.
 */
async function backgroundBrightness(frame: FrameLocator, selector: string): Promise<number> {
  return frame.locator(selector).first().evaluate((element) => {
    const colour = getComputedStyle(element).backgroundColor;
    const channels = (colour.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    if (channels.length < 3) return Number.NaN;
    return channels.reduce((total, value) => total + value, 0) / 3;
  });
}

async function openAdminer(page: Page, theme: 'light' | 'dark'): Promise<FrameLocator> {
  await page.goto('/admin/');

  await page.getByRole('button', { name: /^Тема:/ }).click();
  await page.getByRole('menuitem', { name: theme === 'dark' ? 'Тёмная' : 'Светлая' }).click();

  await page.goto('/admin/?database=true');

  const frame = page.frameLocator('iframe[title="База данных"]');
  await expect(frame.locator('#content')).toBeVisible();

  // The theme arrives by message a moment after the frame loads, so measuring colours before it
  // lands would be reading the wrong page.
  await expect.poll(() => frame.locator('html').getAttribute('data-theme')).toBe(theme);

  return frame;
}

test.describe('the database interface', () => {
  test('is the real Adminer, not a look-alike', async ({ page }) => {
    await signIn(page);
    const frame = await openAdminer(page, 'light');

    // Its own markup and its own stylesheet.
    await expect(frame.locator('#menu')).toBeVisible();
    await expect(frame.locator('#content')).toBeVisible();

    // It found the service databases through the connection it was given.
    await expect(frame.getByRole('link', { name: /_auth$/ })).toBeVisible();
  });

  test('follows the panel into the dark theme, on every screen', async ({ page }) => {
    await signIn(page);
    const frame = await openAdminer(page, 'dark');

    // The database overview.
    await expect.poll(() => backgroundBrightness(frame, 'body')).toBeLessThan(DARK_BACKGROUND_MAX);

    // A table listing inside one database.
    await frame.getByRole('link', { name: /_email$/ }).click();
    await expect(frame.getByRole('link', { name: 'deliveries', exact: true }).first()).toBeVisible();
    await expect.poll(() => backgroundBrightness(frame, 'body')).toBeLessThan(DARK_BACKGROUND_MAX);

    // And the rows of a table, which Adminer styles separately.
    await frame.getByRole('link', { name: 'deliveries', exact: true }).first().click();
    await expect(frame.locator('#content')).toBeVisible();
    await expect.poll(() => backgroundBrightness(frame, 'body')).toBeLessThan(DARK_BACKGROUND_MAX);
  });

  test('follows it back into the light theme', async ({ page }) => {
    await signIn(page);
    const frame = await openAdminer(page, 'light');

    await expect.poll(() => backgroundBrightness(frame, 'body')).toBeGreaterThan(LIGHT_BACKGROUND_MIN);

    await frame.getByRole('link', { name: /_auth$/ }).click();
    await expect(frame.getByRole('link', { name: 'identities', exact: true }).first()).toBeVisible();
    await expect.poll(() => backgroundBrightness(frame, 'body')).toBeGreaterThan(LIGHT_BACKGROUND_MIN);
  });
});
