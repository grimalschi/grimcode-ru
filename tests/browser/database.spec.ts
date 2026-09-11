import { expect, test, type Page } from '@playwright/test';

import { appliedTheme, collectPageErrors, expectNoPageErrors, signIn } from './support.js';

async function openDatabase(page: Page): Promise<void> {
  await signIn(page);
  await page.goto('/admin/database');
  await expect(page.getByRole('heading', { name: 'База данных', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Открыть таблицу / }).first()).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
}

async function chooseSchema(page: Page, schema: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Схема', exact: true }).click();
  await page.getByRole('option', { name: schema, exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Схема', exact: true })).toContainText(schema);
}

async function chooseTable(page: Page, schema: string, table: string): Promise<void> {
  await page.getByRole('button', { name: `Открыть таблицу ${schema}.${table}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: `${schema}.${table}`, level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Колонка / }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Добавить строку', exact: true })).toBeEnabled();
}

const rows = (page: Page) => page.getByRole('table').locator('tbody tr');
const column = (page: Page, name: string) => page.getByRole('button', { name: `Колонка ${name}`, exact: true });
const filters = (page: Page) => page.getByRole('region', { name: 'Фильтры таблицы' });

test.describe('the native database page', () => {
  test('reads the live catalogue in the Admin page', async ({ page }) => {
    const problems = collectPageErrors(page);
    await openDatabase(page);
    await chooseSchema(page, 'auth');
    await chooseTable(page, 'auth', 'identities');
    await expect(rows(page).first()).toBeVisible();
    await expect(column(page, 'email')).toBeVisible();
    await expect(page.getByRole('columnheader').filter({ has: column(page, 'id') })).toContainText('uuid');
    await expect(page.getByTestId('database-cell').first()).toBeVisible();
    expectNoPageErrors(problems);
  });

  for (const endpoint of ['tables', 'rows'] as const) {
    test(`ignores delayed ${endpoint} after switching schemas`, async ({ page }) => {
      const problems = collectPageErrors(page);
      await openDatabase(page);
      if (endpoint === 'rows') await chooseSchema(page, 'auth');

      let arrived!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { arrived = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const path = `/admin/rpc/database.${endpoint}`;
      await page.route(`**${path}`, async (route) => {
        const input = route.request().postDataJSON() as { schema?: string };
        if (input.schema !== 'auth') return route.continue();
        const response = await route.fetch();
        arrived();
        await held;
        await route.fulfill({ response });
      });

      try {
        if (endpoint === 'tables') await chooseSchema(page, 'auth');
        else await page.getByRole('button', { name: 'Открыть таблицу auth.identities', exact: true }).click();
        await started;
        await chooseSchema(page, 'users');
        await chooseTable(page, 'users', 'profiles');
        await expect(column(page, 'display_name')).toBeVisible();

        const delivered = page.waitForResponse((response) =>
          new URL(response.url()).pathname === path &&
          (response.request().postDataJSON() as { schema?: string }).schema === 'auth');
        release();
        await (await delivered).finished();
        await page.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));

        await expect(page.getByRole('combobox', { name: 'Схема', exact: true })).toContainText('users');
        await expect(page.getByRole('heading', { name: 'users.profiles', level: 2 })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Открыть таблицу auth.identities', exact: true })).toHaveCount(0);
        await expect(column(page, 'display_name')).toBeVisible();
        await expect(column(page, 'password_hash')).toHaveCount(0);
        expectNoPageErrors(problems);
      } finally {
        release();
      }
    });
  }

  test('sorts through the column menu and restores the view from its URL', async ({ page }) => {
    await openDatabase(page);
    await chooseSchema(page, 'auth');
    await chooseTable(page, 'auth', 'identities');
    await column(page, 'email').click();
    await page.getByRole('menuitem', { name: 'Сортировать по возрастанию', exact: true }).click();
    const header = page.getByRole('columnheader').filter({ has: column(page, 'email') });
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    const address = page.url();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'auth.identities', level: 2 })).toBeVisible();
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    expect(page.url()).toBe(address);
  });

  test('shows a cell value on hover without opening a dialog', async ({ page }) => {
    await openDatabase(page);
    await chooseSchema(page, 'auth');
    await chooseTable(page, 'auth', 'identities');
    const cell = page.getByTestId('database-cell').filter({ hasText: /./ }).first();
    const value = (await cell.textContent())?.trim() ?? '';
    await cell.hover();
    await expect(page.getByTestId('database-value-preview')).toContainText(value);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(rows(page).first()).toBeVisible();
    // Radix keeps a hoverable preview open while the pointer crosses its grace area.
    // Move through it as a pointer would, so leaving is observed after the first pointerleave.
    const destination = await page.getByRole('link', { name: 'Администраторы', exact: true }).boundingBox();
    if (!destination) throw new Error('The administrators navigation link is not visible');
    await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, { steps: 10 });
    await expect(page.getByTestId('database-value-preview')).toBeHidden();
  });

  test('copies the complete cell value', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openDatabase(page);
    await chooseSchema(page, 'auth');
    await chooseTable(page, 'auth', 'identities');
    const cell = page.getByTestId('database-cell').and(page.locator('[data-column="password_hash"]')).first();
    await cell.click();
    await expect(page.getByText(/скопировано/i)).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/^scrypt\$/);
    expect(copied.length).toBeGreaterThan(60);
  });

  test('indents JSON in a value preview', async ({ page }) => {
    await openDatabase(page);
    await chooseSchema(page, 'admin');
    await chooseTable(page, 'admin', 'admin_audit');
    const cell = page.getByTestId('database-cell').and(page.locator('[data-column="details"]')).filter({ hasText: '{' }).first();
    await cell.hover();
    await expect(page.getByTestId('database-value-preview')).toContainText('\n  ');
  });

  test('ignores empty filters and counts only completed conditions', async ({ page }) => {
    const problems = collectPageErrors(page);
    await openDatabase(page);
    await chooseSchema(page, 'auth');
    await chooseTable(page, 'auth', 'identities');
    await page.getByRole('button', { name: /^Фильтры/ }).click();
    await filters(page).getByRole('button', { name: 'Добавить условие', exact: true }).click();
    await expect(page.getByTestId('database-filter')).toHaveCount(1);
    await expect(rows(page).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Фильтры/ })).toHaveText('Фильтры');
    await page.getByRole('combobox', { name: 'Колонка условия 1', exact: true }).click();
    await page.getByRole('option', { name: 'email', exact: true }).click();
    await filters(page).getByLabel('Значение', { exact: true }).fill('probe');
    await expect(page.getByRole('button', { name: /^Фильтры/ })).toHaveText(/Фильтры\s*\(1\)/);
    expectNoPageErrors(problems);
  });

  test('clears filters while leaving the editor open', async ({ page }) => {
    await openDatabase(page);
    await chooseSchema(page, 'auth');
    await chooseTable(page, 'auth', 'identities');
    await page.getByRole('button', { name: /^Фильтры/ }).click();
    await expect(filters(page).getByRole('button', { name: 'Очистить всё', exact: true })).toHaveCount(0);
    await filters(page).getByRole('button', { name: 'Добавить условие', exact: true }).click();
    await page.getByRole('combobox', { name: 'Колонка условия 1', exact: true }).click();
    await page.getByRole('option', { name: 'email', exact: true }).click();
    await filters(page).getByLabel('Значение', { exact: true }).fill('probe');
    await filters(page).getByRole('button', { name: 'Добавить условие', exact: true }).click();
    await expect(page.getByTestId('database-filter')).toHaveCount(2);
    await filters(page).getByRole('button', { name: 'Очистить всё', exact: true }).click();
    await expect(page.getByTestId('database-filter')).toHaveCount(0);
    await expect(filters(page).getByRole('button', { name: 'Добавить условие', exact: true })).toBeVisible();
    await expect(rows(page).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Фильтры/ })).toHaveText('Фильтры');
  });

  test('offers type-appropriate conditions and leaves unfinished ranges inactive', async ({ page }) => {
    const problems = collectPageErrors(page);
    await openDatabase(page);
    await chooseSchema(page, 'admin');
    await chooseTable(page, 'admin', 'administrators');
    await page.getByRole('button', { name: /^Фильтры/ }).click();
    await filters(page).getByRole('button', { name: 'Добавить условие', exact: true }).click();
    await page.getByRole('combobox', { name: 'Колонка условия 1', exact: true }).click();
    await page.getByRole('option', { name: 'enabled', exact: true }).click();
    await page.getByRole('combobox', { name: 'Условие 1', exact: true }).click();
    await expect(page.getByRole('option', { name: 'да', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: /больше/ })).toHaveCount(0);
    await page.getByRole('option', { name: 'нет', exact: true }).click();
    await expect(filters(page)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Фильтры/ })).toHaveText(/Фильтры\s*\(1\)/);
    await page.getByRole('combobox', { name: 'Колонка условия 1', exact: true }).click();
    await page.getByRole('option', { name: 'created_at', exact: true }).click();
    await page.getByRole('combobox', { name: 'Условие 1', exact: true }).click();
    await page.getByRole('option', { name: 'между', exact: true }).click();
    await expect(filters(page).getByLabel('От', { exact: true })).toBeVisible();
    await expect(filters(page).getByLabel('До', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Фильтры/ })).toHaveText('Фильтры');
    expectNoPageErrors(problems);
  });

  test('asks before deleting a row and preserves it when cancelled', async ({ page }) => {
    await openDatabase(page);
    await chooseSchema(page, 'admin');
    await chooseTable(page, 'admin', 'administrators');
    const before = await rows(page).count();
    await rows(page).first().getByRole('button', { name: 'Удалить строку', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Удалить строку?', exact: true });
    await expect(confirmation).toContainText('нельзя отменить');
    await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(rows(page)).toHaveCount(before);
  });

  test('inserts, edits and deletes its own row, preserving defaults and counts', async ({ page }) => {
    const problems = collectPageErrors(page);
    await openDatabase(page);
    await chooseSchema(page, 'auth');
    await chooseTable(page, 'auth', 'auth_audit');
    const tableButton = page.getByRole('button', { name: 'Открыть таблицу auth.auth_audit', exact: true });
    const count = async () => Number((await tableButton.textContent())?.replace('auth_audit', '').trim());
    const before = await count();
    expect(Number.isNaN(before)).toBe(false);
    const action = `probe.inserted.${Date.now()}`;
    const edited = `${action}.edited`;
    await page.getByRole('button', { name: 'Добавить строку', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'Новая строка' });
    await expect(create.getByText('пусто = по умолчанию').first()).toBeVisible();
    await create.getByLabel('id', { exact: true }).fill(crypto.randomUUID());
    await create.getByLabel('action', { exact: true }).fill(action);
    await create.getByRole('button', { name: 'Добавить', exact: true }).click();
    await expect(create).toBeHidden();
    await column(page, 'created_at').click();
    await page.getByRole('menuitem', { name: 'Сортировать по убыванию', exact: true }).click();
    const inserted = rows(page).filter({ hasText: action });
    await expect(inserted).toBeVisible();
    await expect(inserted).toContainText('{}');
    await expect(inserted).toContainText(/\d{4}-\d{2}-\d{2}T/);
    await expect.poll(count).toBe(before + 1);

    await inserted.getByRole('button', { name: 'Открыть строку', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Строка', exact: true });
    await expect(edit.getByLabel('id', { exact: true })).toBeDisabled();
    await edit.getByLabel('action', { exact: true }).fill(edited);
    await edit.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(edit).toBeHidden();
    const updated = rows(page).filter({ hasText: edited });
    await expect(updated).toBeVisible();
    await updated.getByRole('button', { name: 'Удалить строку', exact: true }).click();
    await page.getByRole('dialog', { name: 'Удалить строку?', exact: true }).getByRole('button', { name: 'Удалить', exact: true }).click();
    await expect(updated).toHaveCount(0);
    await expect.poll(count).toBe(before);
    expectNoPageErrors(problems);
  });

  test('displays both columns of a composite primary key', async ({ page }) => {
    await openDatabase(page);
    await chooseSchema(page, 'admin');
    await chooseTable(page, 'admin', 'administrator_grants');
    await expect(column(page, 'administrator_id')).toBeVisible();
    await expect(column(page, 'module')).toBeVisible();
  });

  test('generates a UUID only for the primary key', async ({ page }) => {
    await openDatabase(page);
    await chooseSchema(page, 'admin');
    await chooseTable(page, 'admin', 'administrators');
    await page.getByRole('button', { name: 'Добавить строку', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Новая строка' });
    await expect(dialog.getByLabel('id', { exact: true })).toHaveValue('');
    await expect(dialog.getByLabel('user_id', { exact: true })).toHaveValue('');
    await expect(dialog.getByRole('button', { name: 'Сгенерировать', exact: true })).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Сгенерировать', exact: true }).click();
    await expect(dialog.getByLabel('id', { exact: true })).toHaveValue(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await expect(dialog.getByLabel('user_id', { exact: true })).toHaveValue('');
    await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  });

  test('hides columns in the view without changing table structure', async ({ page }) => {
    await openDatabase(page);
    await chooseSchema(page, 'auth');
    await chooseTable(page, 'auth', 'identities');
    await expect(page.getByRole('button', { name: /Добавить колонку/ })).toHaveCount(0);
    await column(page, 'email').click();
    await expect(page.getByRole('menuitem', { name: /Переименовать колонку|Удалить колонку/ })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Скрыть колонку', exact: true }).click();
    await expect(column(page, 'email')).toHaveCount(0);
    await page.getByRole('button', { name: 'Показать все колонки', exact: true }).click();
    await expect(column(page, 'email')).toBeVisible();
  });

  test('hides migration tables in every module schema', async ({ page }) => {
    await openDatabase(page);
    for (const [schema, table] of [
      ['admin', 'administrators'], ['auth', 'identities'], ['email', 'templates'],
      ['notifications', 'events'], ['users', 'profiles'],
    ] as const) {
      await chooseSchema(page, schema);
      await expect(page.getByRole('button', { name: `Открыть таблицу ${schema}.${table}`, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: new RegExp(`^Открыть таблицу ${schema}\\.schema_migrations$`) })).toHaveCount(0);
    }
  });

  test('uses a date control for a row timestamp', async ({ page }) => {
    await openDatabase(page);
    await chooseSchema(page, 'auth');
    await chooseTable(page, 'auth', 'auth_audit');
    await page.getByRole('button', { name: 'Добавить строку', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Новая строка' });
    await expect(dialog.getByLabel('created_at', { exact: true })).toHaveAttribute('type', 'datetime-local');
    await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  });

  test('uses the same theme and theme control as Admin', async ({ page }) => {
    await openDatabase(page);
    await expect(page.getByRole('button', { name: /^Тема:/ })).toHaveCount(1);
    await page.getByRole('button', { name: /^Тема:/ }).click();
    await page.getByRole('menuitem', { name: 'Тёмная', exact: true }).click();
    await expect.poll(() => appliedTheme(page)).toBe('dark');
    await expect(page.locator('iframe')).toHaveCount(0);
    await page.getByRole('button', { name: /^Тема:/ }).click();
    await page.getByRole('menuitem', { name: 'Светлая', exact: true }).click();
    await expect.poll(() => appliedTheme(page)).toBe('light');
  });
});
