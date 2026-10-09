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

/** Schemas are sections that stay open; opening one changes nothing else on the page. */
const schemaSection = (page: Page, schema: string) => page.getByRole('button', { name: `Схема ${schema}`, exact: true });

async function chooseSchema(page: Page, schema: string): Promise<void> {
  const section = schemaSection(page, schema);
  if ((await section.getAttribute('aria-expanded')) !== 'true') await section.click();
  await expect(section).toHaveAttribute('aria-expanded', 'true');
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
  // A serial key: PostgreSQL numbers the rows, and the editor must never offer to.
  await database.query(`CREATE TABLE "${fixtureSchema}".numbered (id serial PRIMARY KEY, label text NOT NULL)`);
  // Three kinds of "nothing to see" in one text column: a value, the empty string and SQL NULL.
  await database.query(`CREATE TABLE "${fixtureSchema}".blanks (id integer PRIMARY KEY, label text NOT NULL, blank text, tags text[], born date, seen timestamptz)`);
  await database.query(`INSERT INTO "${fixtureSchema}".blanks VALUES (1, 'filled', 'x', '{a,b}'), (2, 'empty-string', '', '{a}'), (3, 'sql-null', NULL, NULL)`);
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
      let arrived!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { arrived = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const path = `/admin/rpc/database.${endpoint}`;
      // Installed before the page loads: every schema's table list is requested as soon as the
      // page opens, so a hold on `auth` has to be in place from the first request.
      await page.route(`**${path}`, async (route) => {
        const input = route.request().postDataJSON() as { schema?: string };
        if (input.schema !== 'auth') return route.continue();
        const response = await route.fetch();
        arrived();
        await held;
        await route.fulfill({ response });
      });
      await openDatabase(page);
      if (endpoint === 'rows') await chooseSchema(page, 'auth');

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

        // The late answer lands under its own schema and nowhere else: `auth` keeps its section open
        // and now lists its tables, while the page on the right stays with users.profiles.
        await expect(schemaSection(page, 'users')).toHaveAttribute('aria-expanded', 'true');
        await expect(page.getByRole('heading', { name: 'users.profiles', level: 2 })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Открыть таблицу auth.identities', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Открыть таблицу auth.identities', exact: true })).not.toHaveAttribute('aria-current', 'page');
        await expect(page.getByRole('button', { name: 'Открыть таблицу users.profiles', exact: true })).toHaveAttribute('aria-current', 'page');
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

  test('holds the request while a condition is unfilled, marks it and keeps the rows', async ({ page }) => {
    const problems = collectPageErrors(page);
    await openDatabase(page);
    await chooseSchema(page, 'auth');
    await chooseTable(page, 'auth', 'identities');
    await expect(rows(page).first()).toBeVisible();
    const before = await rows(page).count();
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/admin/rpc/database.rows')) requests.push(request.postData() ?? '');
    });
    await page.getByRole('button', { name: /^Фильтры/ }).click();
    await filters(page).getByRole('button', { name: 'Добавить условие', exact: true }).click();
    await expect(page.getByTestId('database-filter')).toHaveCount(1);
    await expect(page.getByRole('button', { name: /^Фильтры/ })).toHaveText(/Фильтры\s*\(1\)/);
    await page.getByRole('combobox', { name: 'Колонка условия 1', exact: true }).click();
    await page.getByRole('option', { name: 'email', exact: true }).click();
    const value = filters(page).getByLabel('Значение', { exact: true }).first();
    // Not pointed at yet: the person has only just added it.
    await expect(value).toHaveAttribute('aria-invalid', 'false');
    // Long enough for the typing pause to have passed: an unfilled condition sends nothing at all.
    await page.waitForTimeout(600);
    expect(requests).toEqual([]);
    await expect(rows(page)).toHaveCount(before);
    // Adding another condition while this one is blank is what points at it.
    await filters(page).getByRole('button', { name: 'Добавить условие', exact: true }).click();
    await expect(value).toHaveAttribute('aria-invalid', 'true');
    await filters(page).getByRole('button', { name: 'Убрать условие 2', exact: true }).click();
    await value.fill('probe');
    await expect(value).toHaveAttribute('aria-invalid', 'false');
    await expect(rows(page).first()).toContainText('Строк нет');
    expect(requests).toHaveLength(1);
    expectNoPageErrors(problems);
  });

  test('waits for typing to pause and keeps the rows on screen while the page reloads', async ({ page }) => {
    const problems = collectPageErrors(page);
    await openDatabase(page);
    await chooseSchema(page, 'auth');
    await chooseTable(page, 'auth', 'identities');
    await expect(rows(page).first()).toBeVisible();
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/admin/rpc/database.rows')) requests.push(request.postData() ?? '');
    });
    let placeholderSeen = false;
    const watcher = page.getByTestId('database-table').locator('[data-slot="skeleton"]');
    const poll = setInterval(() => { void watcher.count().then((count) => { if (count > 0) placeholderSeen = true; }); }, 50);
    await page.getByRole('button', { name: /^Фильтры/ }).click();
    await filters(page).getByRole('button', { name: 'Добавить условие', exact: true }).click();
    await page.getByRole('combobox', { name: 'Колонка условия 1', exact: true }).click();
    await page.getByRole('option', { name: 'email', exact: true }).click();
    await filters(page).getByLabel('Значение', { exact: true }).pressSequentially('nobody', { delay: 40 });
    await expect(page.getByRole('button', { name: /^Фильтры/ })).toHaveText(/Фильтры\s*\(1\)/);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Строк нет');
    clearInterval(poll);
    // Six keystrokes 40 ms apart settle into one request; without the pause there were six.
    expect(requests.filter((input) => input.includes('nobody')).length).toBe(1);
    expect(requests.some((input) => /"value":"n(o(b(o(d)?)?)?)?"/.test(input))).toBe(false);
    expect(placeholderSeen).toBe(false);
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
    await page.getByRole('option', { name: 'от … до', exact: true }).click();
    await expect(filters(page).getByLabel('От', { exact: true })).toBeVisible();
    await expect(filters(page).getByLabel('До', { exact: true })).toBeVisible();
    // Both ends are still blank: the condition counts and asks the server for nothing.
    await expect(page.getByRole('button', { name: /^Фильтры/ })).toHaveText(/Фильтры\s*\(1\)/);
    expectNoPageErrors(problems);
  });

  test('tells SQL NULL from the empty string and keeps empty cells under "or empty"', async ({ page }) => {
    const problems = collectPageErrors(page);
    await openDatabase(page);
    await chooseSchema(page, fixtureSchema);
    await chooseTable(page, fixtureSchema, 'blanks');
    await page.getByRole('button', { name: /^Фильтры/ }).click();
    await filters(page).getByRole('button', { name: 'Добавить условие', exact: true }).click();
    await page.getByRole('combobox', { name: 'Колонка условия 1', exact: true }).click();
    await page.getByRole('option', { name: 'blank', exact: true }).click();

    const choose = async (condition: string) => {
      await page.getByRole('combobox', { name: 'Условие 1', exact: true }).click();
      await page.getByRole('option', { name: condition, exact: true }).click();
    };
    // The previous rows stay on screen until the new page arrives, so each step waits for that answer.
    const settled = async (action: () => Promise<void>) => {
      const answered = page.waitForResponse((response) => response.url().includes('/admin/rpc/database.rows'));
      await action();
      await answered;
    };
    const labels = async () => (await rows(page).allTextContents()).map((text) => /filled|empty-string|sql-null/.exec(text)?.[0]);
    const expectLabels = async (expected: string[]) => {
      await expect(rows(page)).toHaveCount(expected.length);
      expect(await labels()).toEqual(expected);
    };

    await settled(() => choose('пусто'));
    await expectLabels(['sql-null']);
    await settled(() => choose('пустая строка'));
    await expectLabels(['empty-string']);
    await choose('не равно');
    await settled(() => filters(page).getByLabel('Значение', { exact: true }).fill('x'));
    await expectLabels(['empty-string']);
    await settled(() => choose('не равно или пусто'));
    await expectLabels(['empty-string', 'sql-null']);
    // A value typed for text would travel to the array column as an array literal; leave the condition without one first.
    await settled(() => choose('пусто'));

    await settled(async () => {
      await page.getByRole('combobox', { name: 'Колонка условия 1', exact: true }).click();
      await page.getByRole('option', { name: 'tags', exact: true }).click();
    });
    await page.getByRole('combobox', { name: 'Условие 1', exact: true }).click();
    await expect(page.getByRole('option', { name: 'больше', exact: true })).toHaveCount(0);
    await page.getByRole('option', { name: 'содержит значение', exact: true }).click();
    await settled(() => filters(page).getByLabel('Значение', { exact: true }).fill('b'));
    await expectLabels(['filled']);
    expectNoPageErrors(problems);
  });

  test('chains conditions with И and ИЛИ, draws the groups and reorders them', async ({ page }) => {
    const problems = collectPageErrors(page);
    await openDatabase(page);
    await chooseSchema(page, fixtureSchema);
    await chooseTable(page, fixtureSchema, 'blanks');
    await page.getByRole('button', { name: /^Фильтры/ }).click();
    const settled = async (action: () => Promise<void>) => {
      const answered = page.waitForResponse((response) => response.url().includes('/admin/rpc/database.rows'));
      await action();
      await answered;
    };
    const condition = async (index: number, column: string, name: string) => {
      await page.getByRole('combobox', { name: `Колонка условия ${index}`, exact: true }).click();
      await page.getByRole('option', { name: column, exact: true }).click();
      await page.getByRole('combobox', { name: `Условие ${index}`, exact: true }).click();
      await page.getByRole('option', { name, exact: true }).click();
    };
    // The join is a switch: off is И, on is ИЛИ; its name says which.
    const join = page.getByRole('switch', { name: /^Связка между условиями 1 и 2/ });

    await filters(page).getByRole('button', { name: 'Добавить условие', exact: true }).click();
    await settled(() => condition(1, 'blank', 'пустая строка'));
    await filters(page).getByRole('button', { name: 'Добавить условие', exact: true }).click();
    await settled(() => condition(2, 'blank', 'пусто'));
    // Two conditions on one column joined with И: nothing is both an empty string and SQL NULL.
    await expect(join).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('database-filter-block')).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Строк нет');

    await settled(() => join.click());
    await expect(join).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('database-filter-block')).toHaveCount(2);
    await expect(rows(page)).toHaveCount(2);

    // Moving the second condition up by keyboard makes it the first; the join between them starts over as И.
    await page.getByRole('button', { name: 'Переместить условие 2', exact: true }).focus();
    await settled(() => page.keyboard.press('ArrowUp'));
    await expect(page.getByRole('combobox', { name: 'Условие 1', exact: true })).toHaveText('пусто');
    await expect(page.getByRole('combobox', { name: 'Условие 2', exact: true })).toHaveText('пустая строка');
    await expect(page.getByRole('button', { name: 'Переместить условие 1', exact: true })).toBeFocused();
    await expect(join).toHaveAttribute('aria-checked', 'false');
    await expect(rows(page).first()).toContainText('Строк нет');
    expectNoPageErrors(problems);
  });

  test('offers a calendar beside a date box and a time box for a column with a time of day', async ({ page }) => {
    const problems = collectPageErrors(page);
    await openDatabase(page);
    await chooseSchema(page, fixtureSchema);
    await chooseTable(page, fixtureSchema, 'blanks');
    await page.getByRole('button', { name: /^Фильтры/ }).click();
    await filters(page).getByRole('button', { name: 'Добавить условие', exact: true }).click();
    // The calendar opens on the current month when nothing is typed, so the day is picked from it.
    const now = new Date();
    const first = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    await page.getByRole('combobox', { name: 'Колонка условия 1', exact: true }).click();
    await page.getByRole('option', { name: 'born', exact: true }).click();
    const value = filters(page).getByLabel('Значение', { exact: true });
    await expect(value).toHaveValue('');
    await page.getByRole('button', { name: 'Календарь: Значение', exact: true }).click();
    await expect(page.getByRole('dialog').locator('[data-day]').first()).toBeVisible();
    await expect(page.getByLabel('Время: Значение', { exact: true })).toHaveCount(0);
    await page.getByRole('dialog').locator(`[data-day="${first}"] button`).click();
    await expect(value).toHaveValue(first);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.getByRole('combobox', { name: 'Колонка условия 1', exact: true }).click();
    await page.getByRole('option', { name: 'seen', exact: true }).click();
    await page.getByRole('button', { name: 'Календарь: Значение', exact: true }).click();
    await page.getByRole('dialog').locator(`[data-day="${first}"] button`).click();
    await expect(value).toHaveValue(`${first} 00:00`);
    await page.getByLabel('Время: Значение', { exact: true }).fill('12:30');
    await expect(value).toHaveValue(`${first} 12:30`);
    await page.keyboard.press('Escape');
    // Typing stays free: the box takes what PostgreSQL reads, not only what the calendar writes.
    await value.fill(`${first} 12:30:45+03`);
    await expect(rows(page).first()).toContainText('Строк нет');

    // A range is two clicks: picking the start closes its calendar and opens the end's.
    await page.getByRole('combobox', { name: 'Условие 1', exact: true }).click();
    await page.getByRole('option', { name: 'от … до', exact: true }).click();
    await page.getByRole('button', { name: 'Календарь: От', exact: true }).click();
    await page.getByRole('dialog').locator(`[data-day="${first}"] button`).click();
    await expect(filters(page).getByLabel('От', { exact: true })).toHaveValue(`${first} 00:00`);
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await page.getByRole('dialog').locator(`[data-day="${first}"] button`).click();
    await expect(filters(page).getByLabel('До', { exact: true })).toHaveValue(`${first} 00:00`);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expectNoPageErrors(problems);
  });

  test('tells big letters from small only when the switch is on', async ({ page }) => {
    const problems = collectPageErrors(page);
    await openDatabase(page);
    await chooseSchema(page, fixtureSchema);
    await chooseTable(page, fixtureSchema, 'blanks');
    await page.getByRole('button', { name: /^Фильтры/ }).click();
    await filters(page).getByRole('button', { name: 'Добавить условие', exact: true }).click();
    await page.getByRole('combobox', { name: 'Колонка условия 1', exact: true }).click();
    await page.getByRole('option', { name: 'label', exact: true }).click();
    await page.getByRole('combobox', { name: 'Условие 1', exact: true }).click();
    await page.getByRole('option', { name: 'содержит', exact: true }).click();
    await filters(page).getByLabel('Значение', { exact: true }).fill('FILLED');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('filled');
    await page.getByRole('checkbox', { name: 'Учитывать регистр', exact: true }).click();
    await expect(rows(page).first()).toContainText('Строк нет');
    await page.getByRole('checkbox', { name: 'Учитывать регистр', exact: true }).click();
    await expect(rows(page).first()).toContainText('filled');
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

test.describe('columns numbered by the database', () => {
  test('leaves a serial key to PostgreSQL and says so in the form', async ({ page }) => {
    const problems = collectPageErrors(page);
    await openFixture(page, 'numbered');

    const sent: unknown[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/admin/rpc/database.insert')) sent.push(request.postDataJSON());
    });

    for (const label of ['first automatic', 'second automatic']) {
      await page.getByRole('button', { name: 'Добавить строку', exact: true }).click();
      const create = page.getByRole('dialog', { name: 'Новая строка', exact: true });
      const id = create.getByLabel('id', { exact: true });
      await expect(id).toBeDisabled();
      await expect(id).toHaveAttribute('placeholder', 'Автоматически');
      await expect(create.locator('[data-testid="database-field"][data-column="id"]')).toContainText('PostgreSQL назначит значение при сохранении');
      await create.getByLabel('label', { exact: true }).fill(label);
      await create.getByRole('button', { name: 'Добавить', exact: true }).click();
      await expect(create).toBeHidden();
      await expect(rows(page).filter({ hasText: label })).toBeVisible();
    }

    expect(sent).toHaveLength(2);
    for (const body of sent) {
      expect(JSON.stringify(body)).not.toMatch(/"id"/);
    }
    const numbered = await database.query<{ id: string; label: string }>({
      text: `SELECT id, label FROM "${fixtureSchema}".numbered ORDER BY id`, types: { getTypeParser: () => (value: string) => value },
    });
    expect(numbered.rows).toEqual([{ id: '1', label: 'first automatic' }, { id: '2', label: 'second automatic' }]);

    await rows(page).filter({ hasText: 'first automatic' }).getByRole('button', { name: 'Открыть строку', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Строка', exact: true });
    await expect(edit.getByLabel('id', { exact: true })).toBeDisabled();
    await expect(edit.getByLabel('id', { exact: true })).toHaveValue('1');
    await expect(edit.getByLabel('label', { exact: true })).toBeEnabled();
    await edit.getByRole('button', { name: 'Отмена', exact: true }).click();
    expectNoPageErrors(problems);
  });
});

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

  for (const [zoneIndex, timezoneId] of ['UTC', 'Europe/Moscow'].entries()) {
    test.describe(`precise value edits in ${timezoneId}`, () => {
      test.use({ timezoneId });

      const cases = [
        { column: 'precise', next: '2027-02-03 23:59:58.654321+00' },
        { column: 'huge', next: '-9007199254740997.98765432109876543210' },
        { column: 'document', next: ' { "big": 9007199254740997, "fraction": 0.12345678901234567890, "same": 3, "same": 4 } ' },
      ];

      for (const [caseIndex, { column: name, next }] of cases.entries()) {
        test(`edits ${name} without changing its representation or neighbouring values`, async ({ page }) => {
          const problems = collectPageErrors(page);
          const id = 70 + zoneIndex * cases.length + caseIndex;
          const label = `precise-edit-${id}`;
          const initial = {
            precise: '2026-09-12 04:05:06.123456+00',
            huge: '9007199254740993.12345678901234567890',
            document: '{ "big": 9007199254740993, "same": 1, "same": 2 }',
            controls: 'first\r\nsecond\rthird\tend',
          };
          await database.query(`INSERT INTO "${fixtureSchema}"."values"
            (id, label, precise, huge, document, controls) VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, label, initial.precise, initial.huge, initial.document, initial.controls]);
          const before = await storedRow(id);
          expect(before).toMatchObject(initial);

          await openFixture(page);
          await rows(page).filter({ hasText: label }).getByRole('button', { name: 'Открыть строку', exact: true }).click();
          const field = editor(page).getByLabel(name, { exact: true });
          await expect(field).toHaveValue(before![name]!);
          await field.fill(next);
          const request = page.waitForRequest((request) => new URL(request.url()).pathname === '/admin/rpc/database.update');
          await editor(page).getByRole('button', { name: 'Сохранить', exact: true }).click();
          const input = (await request).postDataJSON() as { values: Record<string, string | null>; original: Record<string, string | null> };
          expect(input.values).toEqual({ [name]: next });
          expect(input.original).toEqual(before);
          await expect(editor(page)).toBeHidden();
          const expected = { ...before, [name]: next };
          expect(await storedRow(id)).toEqual(expected);

          // Reload from the server: a correct local draft alone does not prove a lossless round trip.
          await page.reload();
          await rows(page).filter({ hasText: label }).getByRole('button', { name: 'Открыть строку', exact: true }).click();
          await expect(editor(page).getByLabel(name, { exact: true })).toHaveValue(next);
          await expect(editor(page).getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();
          expect(await storedRow(id)).toEqual(expected);
          expectNoPageErrors(problems);
        });
      }
    });
  }

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
