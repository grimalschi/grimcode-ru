import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';

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
}

const rows = (page: Page) => page.getByRole('table').locator('tbody tr');
const column = (page: Page, name: string) => page.getByRole('button', { name: `Колонка ${name}`, exact: true });
const filters = (page: Page) => page.getByRole('region', { name: 'Фильтры таблицы' });

const fixtureSchema = `browser_database_${crypto.randomUUID().replaceAll('-', '')}`;
let database: Pool;

test.beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('Database browser tests require DATABASE_URL');
  database = new Pool({ connectionString: process.env.DATABASE_URL });
  await database.query(`CREATE SCHEMA "${fixtureSchema}"`);
  await database.query(`CREATE TABLE "${fixtureSchema}"."values" (
    id integer PRIMARY KEY,
    label text NOT NULL,
    blank text,
    literal text,
    fallback text DEFAULT 'database default',
    precise timestamptz,
    huge numeric,
    document json,
    controls text,
    bounded varchar(3) DEFAULT 'abc',
    "__proto__" text
  )`);
  await database.query(`INSERT INTO "${fixtureSchema}"."values" (id, label) VALUES (1, 'cancel-delete')`);
  await database.query(`CREATE TYPE "${fixtureSchema}".compound AS (part text)`);
  await database.query(`CREATE TABLE "${fixtureSchema}".unsupported (id integer PRIMARY KEY, value "${fixtureSchema}".compound NOT NULL)`);
  await database.query(`INSERT INTO "${fixtureSchema}".unsupported VALUES (1, ROW('source'))`);
});

test.afterAll(async () => {
  if (!database) return;
  try { await database.query(`DROP SCHEMA IF EXISTS "${fixtureSchema}" CASCADE`); }
  finally { await database.end(); }
});

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

  test('shows JSON source unchanged in a value preview', async ({ page }) => {
    await openDatabase(page);
    await chooseSchema(page, 'admin');
    await chooseTable(page, 'admin', 'admin_audit');
    const cell = page.getByTestId('database-cell').and(page.locator('[data-column="details"]')).filter({ hasText: '{' }).first();
    await cell.hover();
    const source = await cell.textContent();
    await expect(page.getByTestId('database-value-preview').locator('pre')).toHaveText(source ?? '');
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
    await chooseSchema(page, fixtureSchema);
    await chooseTable(page, fixtureSchema, 'values');
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
    await expect(create.getByRole('combobox', { name: 'Режим created_at', exact: true })).toHaveValue('default');
    await create.getByLabel('id', { exact: true }).fill(crypto.randomUUID());
    await create.getByLabel('action', { exact: true }).fill(action);
    await create.getByRole('button', { name: 'Добавить', exact: true }).click();
    await expect(create).toBeHidden();
    await column(page, 'created_at').click();
    await page.getByRole('menuitem', { name: 'Сортировать по убыванию', exact: true }).click();
    const inserted = rows(page).filter({ hasText: action });
    await expect(inserted).toBeVisible();
    await expect(inserted).toContainText('{}');
    await expect(inserted).toContainText(/\d{4}-\d{2}-\d{2} /);
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

  test('edits timestamps as original PostgreSQL text', async ({ page }) => {
    await openDatabase(page);
    await chooseSchema(page, 'auth');
    await chooseTable(page, 'auth', 'auth_audit');
    await page.getByRole('button', { name: 'Добавить строку', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Новая строка' });
    await expect(dialog.getByLabel('created_at', { exact: true })).toHaveAttribute('type', 'text');
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

async function openFixture(page: Page, table = 'values') {
  await openDatabase(page);
  await chooseSchema(page, fixtureSchema);
  await chooseTable(page, fixtureSchema, table);
}

async function storedRow(id: number) {
  const result = await database.query<Record<string, string | null>>({
    text: `SELECT * FROM "${fixtureSchema}"."values" WHERE id = $1`, values: [id],
    types: { getTypeParser: () => (value: string) => value },
  });
  return result.rows[0];
}

const editor = (page: Page) => page.getByRole('dialog', { name: 'Строка', exact: true });

test.describe('lossless database editing in the browser', () => {
  test('copies control-bearing text without changing its line endings', async ({ page, context }) => {
    const source = 'first\r\nsecond\rthird\nfourth\tend';
    await database.query(`INSERT INTO "${fixtureSchema}"."values" (id, label, controls) VALUES (60, 'exact-copy', $1)`, [source]);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page);
    await rows(page).filter({ hasText: 'exact-copy' }).locator('[data-testid="database-cell"][data-column="controls"]').click();
    await expect(page.getByText('Значение скопировано', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
    expect((await storedRow(60))?.controls).toBe(source);
  });

  for (const unavailable of ['missing', 'denied'] as const) {
    test(`refuses copying when clipboard access is ${unavailable}`, async ({ page }) => {
      const id = unavailable === 'missing' ? 61 : 62;
      const label = `refused-copy-${unavailable}`;
      await database.query(`INSERT INTO "${fixtureSchema}"."values" (id, label, controls) VALUES ($1, $2, $3)`, [id, label, 'first\r\nsecond\rlast']);
      const before = await storedRow(id);
      await openFixture(page);
      await page.evaluate((state) => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: state === 'missing' ? undefined : {
            writeText: () => Promise.reject(new DOMException('Копирование запрещено браузером.', 'NotAllowedError')),
          },
        });
        Object.defineProperty(document, 'execCommand', {
          configurable: true,
          value: () => { document.documentElement.dataset.legacyCopyCalled = 'true'; return true; },
        });
      }, unavailable);
      await rows(page).filter({ hasText: label }).locator('[data-testid="database-cell"][data-column="controls"]').click();
      const message = unavailable === 'missing' ? 'Браузер не поддерживает безопасное копирование.' : 'Копирование запрещено браузером.';
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      await expect(page.getByText('Значение скопировано', { exact: true })).toHaveCount(0);
      await expect(page.locator('html')).not.toHaveAttribute('data-legacy-copy-called', 'true');
      expect(await storedRow(id)).toEqual(before);
    });
  }

  test('keeps empty text, literal null, SQL NULL and defaults distinct', async ({ page }) => {
    await openFixture(page);
    await page.getByRole('button', { name: 'Добавить строку', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'Новая строка', exact: true });
    await create.getByLabel('id', { exact: true }).fill('10');
    await create.getByLabel('label', { exact: true }).fill('explicit-states');
    await create.getByRole('combobox', { name: 'Режим blank', exact: true }).selectOption('value');
    await create.getByLabel('blank', { exact: true }).fill('');
    await create.getByRole('combobox', { name: 'Режим literal', exact: true }).selectOption('value');
    await create.getByLabel('literal', { exact: true }).fill('null');
    await expect(create.getByRole('combobox', { name: 'Режим fallback', exact: true })).toHaveValue('default');
    await create.getByRole('button', { name: 'Добавить', exact: true }).click();
    await expect(create).toBeHidden();
    expect(await storedRow(10)).toMatchObject({ blank: '', literal: 'null', fallback: 'database default', precise: null });

    const row = rows(page).filter({ hasText: 'explicit-states' });
    await row.getByRole('button', { name: 'Открыть строку', exact: true }).click();
    await editor(page).getByRole('combobox', { name: 'Режим blank', exact: true }).selectOption('null');
    await editor(page).getByRole('combobox', { name: 'Режим fallback', exact: true }).selectOption('value');
    await editor(page).getByLabel('fallback', { exact: true }).fill('');
    await editor(page).getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(editor(page)).toBeHidden();
    expect(await storedRow(10)).toMatchObject({ blank: null, literal: 'null', fallback: '' });

    await row.getByRole('button', { name: 'Открыть строку', exact: true }).click();
    await editor(page).getByRole('combobox', { name: 'Режим blank', exact: true }).selectOption('value');
    await editor(page).getByLabel('blank', { exact: true }).fill('');
    await editor(page).getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(editor(page)).toBeHidden();
    expect(await storedRow(10)).toMatchObject({ blank: '', literal: 'null', fallback: '' });
  });

  test('changes only the edited field and preserves precise and control-bearing neighbours', async ({ page }) => {
    const controls = 'first\r\nsecond\rthird\nfourth\tend';
    const document = '{ "number": 9007199254740993, "same": 1, "same": 2 }';
    await database.query(`INSERT INTO "${fixtureSchema}"."values"
      (id, label, precise, huge, document, controls, "__proto__") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [20, 'exact-neighbours', '2026-09-12 04:05:06.123456+00', '9007199254740993.12345678901234567890', document, controls, 'own property']);
    const before = await storedRow(20);
    await openFixture(page);
    await rows(page).filter({ hasText: 'exact-neighbours' }).getByRole('button', { name: 'Открыть строку', exact: true }).click();
    await expect(editor(page).getByLabel('precise', { exact: true })).toHaveValue('2026-09-12 04:05:06.123456+00');
    await expect(editor(page).getByLabel('huge', { exact: true })).toHaveValue('9007199254740993.12345678901234567890');
    await expect(editor(page).getByLabel('document', { exact: true })).toHaveValue(document);
    await expect(editor(page).getByLabel('controls', { exact: true })).toHaveValue(JSON.stringify(controls));
    await expect(editor(page).getByLabel('__proto__', { exact: true })).toHaveValue('own property');
    await expect(editor(page).getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();

    const documentField = editor(page).locator('[data-testid="database-field"][data-column="document"]');
    await documentField.getByRole('checkbox', { name: 'Экранировать спецсимволы', exact: true }).check();
    await expect(editor(page).getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();
    await documentField.getByRole('checkbox', { name: 'Экранировать спецсимволы', exact: true }).uncheck();
    await expect(editor(page).getByLabel('document', { exact: true })).toHaveValue(document);

    await editor(page).getByLabel('label', { exact: true }).fill('exact-neighbours-edited');
    const request = page.waitForRequest((request) => new URL(request.url()).pathname === '/admin/rpc/database.update');
    await editor(page).getByRole('button', { name: 'Сохранить', exact: true }).click();
    const input = (await request).postDataJSON() as { values: Record<string, string | null>; original: Record<string, string | null> };
    expect(input.values).toEqual({ label: 'exact-neighbours-edited' });
    expect(input.original).toEqual(before);
    await expect(editor(page)).toBeHidden();
    expect(await storedRow(20)).toEqual({ ...before, label: 'exact-neighbours-edited' });

    await rows(page).filter({ hasText: 'exact-neighbours-edited' }).getByRole('button', { name: 'Открыть строку', exact: true }).click();
    await editor(page).getByLabel('__proto__', { exact: true }).fill('changed own property');
    await editor(page).getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(editor(page)).toBeHidden();
    expect(Object.getOwnPropertyDescriptor(await storedRow(20), '__proto__')?.value).toBe('changed own property');
  });

  test('edits escaped text and intercepts pasted CRLF without normalization', async ({ page }) => {
    await database.query(`INSERT INTO "${fixtureSchema}"."values" (id, label, controls, blank) VALUES (30, 'control-editing', $1, 'prefix-suffix')`, ['first\r\nsecond\rthird']);
    await openFixture(page);
    const row = rows(page).filter({ hasText: 'control-editing' });
    await row.getByRole('button', { name: 'Открыть строку', exact: true }).click();
    const changedControls = 'first\r\nSECOND\rthird\tend';
    await editor(page).getByLabel('controls', { exact: true }).fill(JSON.stringify(changedControls));
    const blank = editor(page).getByLabel('blank', { exact: true });
    await blank.evaluate((element) => {
      const input = element as HTMLInputElement;
      input.focus();
      input.setSelectionRange(7, 7);
      const data = new DataTransfer();
      data.setData('text/plain', 'pasted\r\nwith\rlines\t');
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    const expectedBlank = 'prefix-pasted\r\nwith\rlines\tsuffix';
    await expect(blank).toHaveValue(JSON.stringify(expectedBlank));
    await editor(page).getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(editor(page)).toBeHidden();
    expect(await storedRow(30)).toMatchObject({ controls: changedControls, blank: expectedBlank });
  });

  test('shows unsupported data read-only and refuses adding a required unsupported value', async ({ page }) => {
    await openFixture(page, 'unsupported');
    await expect(page.getByRole('button', { name: 'Добавить строку', exact: true })).toBeDisabled();
    await rows(page).first().getByRole('button', { name: 'Открыть строку', exact: true }).click();
    await expect(editor(page).getByLabel('value', { exact: true })).toBeDisabled();
    await expect(editor(page)).toContainText('Только чтение');
    await expect(editor(page).getByLabel('value', { exact: true })).toHaveValue('(source)');
    await expect(editor(page).getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();
  });

  test('refuses native text drops before Chromium normalizes their line endings', async ({ page }) => {
    await database.query(`INSERT INTO "${fixtureSchema}"."values" (id, label, blank) VALUES (35, 'no-normalized-drop', 'original source')`);
    const before = await storedRow(35);
    await openFixture(page);
    await rows(page).filter({ hasText: 'no-normalized-drop' }).getByRole('button', { name: 'Открыть строку', exact: true }).click();
    const input = editor(page).getByLabel('blank', { exact: true });
    await input.scrollIntoViewIfNeeded();
    const bounds = await input.boundingBox();
    if (!bounds) throw new Error('The source input is not visible');
    const client = await page.context().newCDPSession(page);
    try {
      const data = { items: [{ mimeType: 'text/plain', data: 'first\r\nsecond\rthird' }], dragOperationsMask: 1 };
      // A native Chromium drop performs text normalization; synthetic DOM dispatchEvent does not.
      for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
        await client.send('Input.dispatchDragEvent', { type, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, data });
      }
    } finally { await client.detach(); }
    await expect(page.getByText('Вставьте текст из буфера обмена: перетаскивание может изменить спецсимволы.', { exact: true })).toBeVisible();
    await expect(input).toHaveValue('original source');
    await expect(editor(page).getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();
    expect(await storedRow(35)).toEqual(before);
  });

  test('preserves the database and the draft when PostgreSQL would truncate the input', async ({ page }) => {
    await database.query(`INSERT INTO "${fixtureSchema}"."values" (id, label, bounded) VALUES (40, 'no-truncation', 'abc')`);
    await openFixture(page);
    await rows(page).filter({ hasText: 'no-truncation' }).getByRole('button', { name: 'Открыть строку', exact: true }).click();
    await editor(page).getByLabel('bounded', { exact: true }).fill('abcdef');
    const response = page.waitForResponse((response) => new URL(response.url()).pathname === '/admin/rpc/database.update');
    await editor(page).getByRole('button', { name: 'Сохранить', exact: true }).click();
    expect((await response).ok()).toBe(false);
    await expect(editor(page)).toBeVisible();
    await expect(editor(page).getByLabel('bounded', { exact: true })).toHaveValue('abcdef');
    expect((await storedRow(40))?.bounded).toBe('abc');
  });

  test('keeps concurrent changes and leaves a stale edit open for review', async ({ page }) => {
    await database.query(`INSERT INTO "${fixtureSchema}"."values" (id, label, blank) VALUES (50, 'stale-edit', 'old')`);
    await openFixture(page);
    await rows(page).filter({ hasText: 'stale-edit' }).getByRole('button', { name: 'Открыть строку', exact: true }).click();
    await database.query(`UPDATE "${fixtureSchema}"."values" SET blank = 'external change' WHERE id = 50`);
    await editor(page).getByLabel('blank', { exact: true }).fill('my change');
    const response = page.waitForResponse((response) => new URL(response.url()).pathname === '/admin/rpc/database.update');
    await editor(page).getByRole('button', { name: 'Сохранить', exact: true }).click();
    expect((await response).ok()).toBe(false);
    await expect(editor(page)).toBeVisible();
    await expect(editor(page).getByLabel('blank', { exact: true })).toHaveValue('my change');
    expect((await storedRow(50))?.blank).toBe('external change');
  });
});
