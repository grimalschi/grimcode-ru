import { expect, test } from '@playwright/test';

import { appliedTheme, collectPageErrors, expectNoPageErrors, signIn } from './support.js';

/**
 * The central Admin shell in a real browser.
 *
 * These are the questions an HTTP request cannot answer: whether the bundle runs without throwing,
 * whether a theme reaches an embedded service admin, and whether navigation inside an iframe
 * survives the shell's own URL bookkeeping.
 */

test.describe('the admin shell', () => {
  test('loads and renders without a single runtime error', async ({ page }) => {
    const problems = collectPageErrors(page);

    await signIn(page);
    await page.goto('/admin/');

    await expect(page.getByRole('link', { name: 'Auth' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'База данных' })).toBeVisible();

    expectNoPageErrors(problems);
  });

  test('shows the owner every service and the database area', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/');

    for (const label of ['Auth', 'Users', 'Notifications', 'Email', 'База данных']) {
      await expect(page.getByRole('link', { name: label })).toBeVisible();
    }
  });

  test('opens the owner-only screens', async ({ page }) => {
    const problems = collectPageErrors(page);

    await signIn(page);
    await page.goto('/admin/administrators');

    await expect(page.getByRole('heading', { name: 'Администраторы' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Добавить администратора' })).toBeVisible();

    await page.goto('/admin/audit');
    await expect(page.getByRole('heading', { name: 'Журнал' })).toBeVisible();

    expectNoPageErrors(problems);
  });
});

test.describe('themes', () => {
  test('applies the choice to the shell itself', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/');

    await page.getByRole('button', { name: /^Тема:/ }).click();
    await page.getByRole('menuitem', { name: 'Тёмная' }).click();
    await expect.poll(() => appliedTheme(page)).toBe('dark');

    await page.getByRole('button', { name: /^Тема:/ }).click();
    await page.getByRole('menuitem', { name: 'Светлая' }).click();
    await expect.poll(() => appliedTheme(page)).toBe('light');
  });

  test('survives a reload, so a dark panel does not flash white', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/');

    await page.getByRole('button', { name: /^Тема:/ }).click();
    await page.getByRole('menuitem', { name: 'Тёмная' }).click();
    await expect.poll(() => appliedTheme(page)).toBe('dark');

    await page.reload();
    // Applied by the inline script before the first paint, not after the bundle boots.
    expect(await appliedTheme(page)).toBe('dark');
  });

  /**
   * The shell owns the theme; an embedded service admin has no say in it and must not show a
   * second switch that could disagree.
   */
  test('reaches an embedded service admin', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/?service=auth#/');

    const frame = page.frameLocator('iframe[title="Админка Auth"]');
    await expect(frame.getByRole('link', { name: 'Пользователи' })).toBeVisible();

    await page.getByRole('button', { name: /^Тема:/ }).click();
    await page.getByRole('menuitem', { name: 'Тёмная' }).click();

    await expect
      .poll(async () => frame.locator('html').getAttribute('data-theme'))
      .toBe('dark');

    // And the embedded admin offers no switch of its own.
    await expect(frame.getByRole('button', { name: /^Тема:/ })).toHaveCount(0);

    await page.getByRole('button', { name: /^Тема:/ }).click();
    await page.getByRole('menuitem', { name: 'Светлая' }).click();
    await expect
      .poll(async () => frame.locator('html').getAttribute('data-theme'))
      .toBe('light');
  });
});

test.describe('the frame protocol', () => {
  test('lets an embedded admin navigate without the shell pulling it back', async ({ page }) => {
    const problems = collectPageErrors(page);

    await signIn(page);
    await page.goto('/admin/?service=auth#/');

    const frame = page.frameLocator('iframe[title="Админка Auth"]');
    await expect(frame.getByRole('link', { name: 'Пользователи' })).toBeVisible();

    // Navigation that starts inside the iframe.
    await frame.getByRole('link', { name: 'Журнал безопасности' }).click();
    await expect(frame.getByRole('heading', { name: 'Журнал безопасности' })).toBeVisible();

    // The shell follows it into its own URL...
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/audit');

    // ...and does not send the old path back, which would cancel the navigation that just happened.
    await page.waitForTimeout(500);
    await expect(frame.getByRole('heading', { name: 'Журнал безопасности' })).toBeVisible();

    expectNoPageErrors(problems);
  });

  /**
   * The regression this exists for: the frame's `src` is built once so that navigation inside a
   * service does not reload it, which meant choosing a different service left the old one on
   * screen.
   */
  test('actually changes service when another one is chosen', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/?service=auth#/');

    await expect(
      page.frameLocator('iframe[title="Админка Auth"]').getByRole('link', { name: 'Пользователи' }),
    ).toBeVisible();

    await page.getByRole('link', { name: 'Email' }).click();
    await expect(
      page.frameLocator('iframe[title="Админка Email"]').getByRole('heading', { name: 'Шаблоны' }),
    ).toBeVisible();

    await page.getByRole('link', { name: 'Users' }).click();
    await expect(
      page.frameLocator('iframe[title="Админка Users"]').getByRole('heading', { name: 'Профили' }),
    ).toBeVisible();

    // And back again, which is where a cached frame would show the wrong service.
    await page.getByRole('link', { name: 'Auth' }).click();
    await expect(
      page.frameLocator('iframe[title="Админка Auth"]').getByRole('heading', { name: 'Пользователи' }),
    ).toBeVisible();
  });

  test('opens a deep link straight into the embedded admin', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/?service=auth#/audit');

    const frame = page.frameLocator('iframe[title="Админка Auth"]');
    await expect(frame.getByRole('heading', { name: 'Журнал безопасности' })).toBeVisible();
  });

  test('keeps the protected URL working when opened on its own', async ({ page }) => {
    const problems = collectPageErrors(page);

    await signIn(page);
    await page.goto('/admin/service/auth/audit');

    await expect(page.getByRole('heading', { name: 'Журнал безопасности' })).toBeVisible();
    // Standing alone it owns its theme, so the switch is there.
    await expect(page.getByRole('button', { name: /^Тема:/ })).toBeVisible();

    expectNoPageErrors(problems);
  });
});
