import { expect, test, type Locator } from '@playwright/test';

import { appliedTheme, collectPageErrors, expectNoPageErrors, OWNER_EMAIL, signIn } from './support.js';

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

    await expect(page.getByRole('link', { name: 'Пользователи', exact: true })).toBeVisible();
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

    // The screen's own title, and beside it the module's name, as its schema is called in the database.
    await expect(page.getByRole('link', { name: /^(Письма|События|Пользователи|Профили)$/ })).toHaveText([
      /^Письма\s*email$/, /^События\s*notifications$/, /^Пользователи\s*auth$/, /^Профили\s*users$/,
    ]);
    await expect.poll(async () => {
      const icons = await page.getByRole('link', { name: /^(Письма|События|Пользователи|Профили)$/ })
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
    await expect(page.getByRole('link', { name: 'Пользователи', exact: true })).toHaveAttribute('data-active', 'true');
    await expect(page.getByRole('link', { name: 'Профили', exact: true })).toHaveAttribute('data-active', 'false');

    await page.goto('/admin/administrators');
    await expect(page.getByRole('link', { name: 'Администраторы' })).toHaveAttribute(
      'data-active',
      'true',
    );
    await expect(page.getByRole('link', { name: 'Пользователи', exact: true })).toHaveAttribute('data-active', 'false');

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
    // The database browser is the one screen without a page header: nothing above the tool.
    await expect(page.getByRole('button', { name: /^Схема / }).first()).toBeVisible();
    await expect(page.locator('h1')).toHaveCount(0);
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Схема / }).first()).toBeVisible();

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

  test('is offered in Russian in the application as well', async ({ page }) => {
    await signIn(page);
    await page.goto('/app/');

    await page.getByRole('button', { name: 'Тема: Как в системе' }).click();
    await expect(page.getByRole('menuitem')).toHaveText(['Светлая', 'Тёмная', 'Как в системе']);
    await page.getByRole('menuitem', { name: 'Тёмная' }).click();
    await expect.poll(() => appliedTheme(page)).toBe('dark');
    await expect(page.getByRole('button', { name: 'Тема: Тёмная' })).toBeVisible();

    await page.getByRole('button', { name: 'Тема: Тёмная' }).click();
    await page.getByRole('menuitem', { name: 'Как в системе' }).click();
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

    const frame = page.frameLocator('iframe[title="Админка Пользователи"]');
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

    const frame = page.frameLocator('iframe[title="Админка Пользователи"]');
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
      page.frameLocator('iframe[title="Админка Пользователи"]').getByRole('link', { name: 'Пользователи' }),
    ).toBeVisible();

    await page.getByRole('link', { name: 'Письма', exact: true }).click();
    await expect(
      page.frameLocator('iframe[title="Админка Письма"]').getByRole('heading', { name: 'Шаблоны' }),
    ).toBeVisible();

    await page.getByRole('link', { name: 'Профили', exact: true }).click();
    await expect(
      page.frameLocator('iframe[title="Админка Профили"]').getByRole('heading', { name: 'Профили' }),
    ).toBeVisible();

    // And back again, which is where a cached frame would show the wrong module.
    await page.getByRole('link', { name: 'Пользователи', exact: true }).click();
    await expect(
      page.frameLocator('iframe[title="Админка Пользователи"]').getByRole('heading', { name: 'Пользователи' }),
    ).toBeVisible();
  });

  test('opens a deep link straight into the embedded admin', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/module/auth#/audit');

    const frame = page.frameLocator('iframe[title="Админка Пользователи"]');
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

/**
 * Tailwind 4 gives buttons the arrow cursor; each screen restores the hand in its own stylesheet, so
 * each one is checked: the shell, the four module admins standing alone, and the application.
 */
test.describe('the pointer', () => {
  test('is a hand over what can be pressed, on every screen', async ({ page }) => {
    const cursor = (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).cursor);
    await signIn(page);

    await page.goto('/admin/');
    expect(await cursor(page.getByRole('button', { name: /^Тема:/ })), 'admin').toBe('pointer');
    // The icons under the sidebar are grey and darken under the pointer, as in the application header.
    const signOut = page.getByRole('button', { name: 'Выйти' });
    const color = () => signOut.evaluate((element) => getComputedStyle(element).color);
    const atRest = await color();
    await signOut.hover();
    await expect.poll(color).not.toBe(atRest);

    for (const module of ['auth', 'users', 'email', 'notifications']) {
      await page.goto(`/admin/embed/module/${module}/`);
      const toggle = page.getByRole('button', { name: /^Тема:/ });
      await expect(toggle, module).toBeVisible();
      expect(await cursor(toggle), module).toBe('pointer');
    }

    await page.goto('/app/settings');
    expect(await cursor(page.getByRole('tab', { name: 'Аккаунт' })), 'application tab').toBe('pointer');
    expect(await cursor(page.getByRole('button', { name: 'Выйти' })), 'application button').toBe('pointer');
  });
});

test.describe('the user card', () => {
  test('puts each action on the line of what it changes, and names the owner as unblockable', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/embed/module/auth/');
    await page.getByRole('row').filter({ hasText: OWNER_EMAIL }).click();

    const card = page.getByRole('dialog');
    await expect(card.getByText('Пароль и почту меняет только сам человек — отсюда можно лишь отправить ему ссылку.')).toBeVisible();
    // Matched whole: «Роль» is also inside «Пароль».
    const line = (label: string) => card.locator('dl > div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) });
    await expect(line('Пароль').getByRole('button', { name: 'Отправить ссылку сброса' })).toBeVisible();
    await expect(line('Сессии').getByRole('button', { name: 'Завершить все' })).toBeVisible();
    await expect(line('Блокировка')).toHaveText(/^Блокировка\s*Нет$/);
    await expect(line('Роль')).toContainText('Владелец панели — заблокировать нельзя');
  });
});

test.describe('a search in a module list', () => {
  test('keeps the rows on screen, dimmed, while the answer is on its way', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/embed/module/auth/');
    const owner = page.getByRole('row').filter({ hasText: OWNER_EMAIL });
    await expect(owner).toBeVisible();

    // Hold the search's answer back, so the in-between state can be looked at.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/rpc/listIdentities*', async (route) => { await held; await route.continue(); });
    await page.getByPlaceholder('Поиск по адресу').fill(OWNER_EMAIL.slice(0, 5));

    await expect(page.locator('tbody[aria-busy="true"]')).toBeVisible();
    await expect(owner).toBeVisible();
    await expect(page.locator('tbody [data-slot="skeleton"]')).toHaveCount(0);
    release();
    await expect(page.locator('tbody[aria-busy="false"]')).toBeVisible();
  });
});
