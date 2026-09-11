import { expect, test } from '@playwright/test';

import { appliedTheme, collectPageErrors, expectNoPageErrors, signIn } from './support.js';

/**
 * The central Admin shell in a real browser.
 *
 * These are the questions an HTTP request cannot answer: whether the bundle runs without throwing,
 * whether a theme reaches an embedded module admin, and whether navigation inside an iframe
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

  test('toggles narrow-screen navigation at the same position', async ({ page }) => {
    const problems = collectPageErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await page.goto('/admin/');

    const openMenu = page.getByRole('button', { name: 'Открыть меню', exact: true });
    const header = page.locator('header').filter({ has: openMenu });
    await expect(header.getByText('Admin', { exact: true })).toBeVisible();
    const buttonBox = await openMenu.boundingBox();
    if (!buttonBox) throw new Error('Mobile menu button has no bounding box');
    const point = { x: buttonBox.x + buttonBox.width / 2, y: buttonBox.y + buttonBox.height / 2 };

    await page.mouse.click(point.x, point.y);
    const menu = page.getByRole('dialog');
    const toggleMenu = menu.getByRole('button', { name: 'Переключить меню', exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByText('Admin', { exact: true })).toBeVisible();
    await expect.poll(() => toggleMenu.boundingBox()).toEqual(buttonBox);

    await page.mouse.click(point.x, point.y);
    await expect(menu).toBeHidden();
    await expect(header.getByText('Admin', { exact: true })).toBeVisible();
    await expect.poll(() => openMenu.boundingBox()).toEqual(buttonBox);

    await page.mouse.click(point.x, point.y);
    await expect(menu).toBeVisible();
    await expect.poll(() => toggleMenu.boundingBox()).toEqual(buttonBox);
    const administrators = menu.getByRole('link', { name: 'Администраторы', exact: true });
    await expect(administrators).toBeVisible();
    await administrators.click();
    await expect(page).toHaveURL(/\/admin\/administrators$/);
    expectNoPageErrors(problems);
  });

  test('shows modules in catalogue order and the database area to the owner', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/');

    await expect(page.getByRole('link', { name: /^(Email|Notifications|Auth|Users)$/ })).toHaveText([
      'Email', 'Notifications', 'Auth', 'Users',
    ]);
    await expect.poll(async () => {
      const icons = await page.getByRole('link', { name: /^(Email|Notifications|Auth|Users)$/ })
        .locator('svg').evaluateAll((nodes) => nodes.map((node) => node.innerHTML));
      return new Set(icons).size;
    }).toBe(4);
    await expect(page.getByRole('link', { name: 'База данных', exact: true })).toBeVisible();
  });

  /**
   * The sidebar is the only thing on the screen that says which section is open: a module admin
   * fills the frame with its own page, and the panel around it would otherwise look the same
   * everywhere.
   */
  test('keeps the open section marked in the sidebar', async ({ page }) => {
    await signIn(page);

    await page.goto('/admin/module/auth#/');
    await expect(page.getByRole('link', { name: 'Auth' })).toHaveAttribute('data-active', 'true');
    await expect(page.getByRole('link', { name: 'Users' })).toHaveAttribute('data-active', 'false');

    await page.goto('/admin/administrators');
    await expect(page.getByRole('link', { name: 'Администраторы' })).toHaveAttribute(
      'data-active',
      'true',
    );
    await expect(page.getByRole('link', { name: 'Auth' })).toHaveAttribute('data-active', 'false');

    await page.goto('/admin/database');
    await expect(page.getByRole('link', { name: 'База данных' })).toHaveAttribute(
      'data-active',
      'true',
    );
  });

  test('opens the owner-only screens', async ({ page }) => {
    const problems = collectPageErrors(page);

    await signIn(page);
    await page.goto('/admin/administrators');

    await expect(page.getByRole('heading', { name: 'Администраторы' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Добавить администратора' })).toBeVisible();

    await page.goto('/admin/audit');
    await expect(page.getByRole('heading', { name: 'Журнал' })).toBeVisible();

    await page.goto('/admin/database');
    await expect(page.getByRole('heading', { name: 'База данных', level: 1 })).toBeVisible();
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Схема', exact: true })).toBeVisible();

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
   * The shell owns the theme; an embedded module admin has no say in it and must not show a
   * second switch that could disagree.
   */
  test('reaches an embedded module admin', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/module/auth#/');

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
    await page.goto('/admin/module/auth#/');

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
   * module does not reload it, which meant choosing a different module left the old one on
   * screen.
   */
  test('actually changes module when another one is chosen', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/module/auth#/');

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

    // And back again, which is where a cached frame would show the wrong module.
    await page.getByRole('link', { name: 'Auth' }).click();
    await expect(
      page.frameLocator('iframe[title="Админка Auth"]').getByRole('heading', { name: 'Пользователи' }),
    ).toBeVisible();
  });

  test('opens a deep link straight into the embedded admin', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/module/auth#/audit');

    const frame = page.frameLocator('iframe[title="Админка Auth"]');
    await expect(frame.getByRole('heading', { name: 'Журнал безопасности' })).toBeVisible();
  });

  test('keeps the protected URL working when opened on its own', async ({ page }) => {
    const problems = collectPageErrors(page);

    await signIn(page);
    await page.goto('/admin/embed/module/auth/audit');

    await expect(page.getByRole('heading', { name: 'Журнал безопасности' })).toBeVisible();
    // Standing alone it owns its theme, so the switch is there.
    await expect(page.getByRole('button', { name: /^Тема:/ })).toBeVisible();

    expectNoPageErrors(problems);
  });
});
