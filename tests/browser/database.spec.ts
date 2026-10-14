import { expect, test, type Locator, type Page } from '@playwright/test';
import { Pool } from 'pg';

import { appliedTheme, collectPageErrors, expectNoPageErrors, signIn } from './support.js';

async function openDatabase(page: Page): Promise<void> {
  await signIn(page);
  await page.goto('/admin/database');
  // The page has no header of its own; the schema list is what says it has loaded.
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(0);
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
const sorting = (page: Page) => page.getByRole('region', { name: 'Сортировка таблицы' });

/**
 * Sorts by a column through the panel, opening it when closed; the panel stays open afterwards.
 * A column already on a level (a table opens sorted by the column rows arrive in) gets its
 * direction set; any other is added as the next level.
 */
async function addSortLevel(page: Page, column: string, direction: 'asc' | 'desc'): Promise<void> {
  const button = page.getByRole('button', { name: /^Сортировка/ });
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  let at = 0;
  for (let level = 1; level <= await page.getByTestId('database-sort-level').count(); level++) {
    if ((await page.getByRole('combobox', { name: `Колонка условия ${level}`, exact: true }).textContent()) === column) at = level;
  }
  if (at === 0) {
    await sorting(page).getByRole('button', { name: 'Добавить условие', exact: true }).click();
    at = await page.getByTestId('database-sort-level').count();
    await page.getByRole('combobox', { name: `Колонка условия ${at}`, exact: true }).click();
    await page.getByRole('option', { name: column, exact: true }).click();
  }
  const toggle = page.getByRole('switch', { name: new RegExp(`^Направление условия ${at}`) });
  if (((await toggle.getAttribute('aria-checked')) === 'true') !== (direction === 'desc')) await toggle.click();
}

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
  await database.query(`CREATE TABLE "${fixtureSchema}".blanks (id integer PRIMARY KEY, label text NOT NULL, blank text, tags text[], born date, seen timestamptz, grade integer)`);
  // `grade` ties two rows, so a second sort level has something to decide.
  await database.query(`INSERT INTO "${fixtureSchema}".blanks (id, label, blank, tags, grade) VALUES (1, 'filled', 'x', '{a,b}', 2), (2, 'empty-string', '', '{a}', 1), (3, 'sql-null', NULL, NULL, 1)`);
  await database.query(`CREATE TYPE "${fixtureSchema}".compound AS (part text)`);
  await database.query(`CREATE TABLE "${fixtureSchema}".unsupported (id integer PRIMARY KEY, value "${fixtureSchema}".compound NOT NULL)`);
  await database.query(`INSERT INTO "${fixtureSchema}".unsupported VALUES (1, ROW('source'))`);
  // A view beside the tables: opened and read like one, never written.
  await database.query(`CREATE VIEW "${fixtureSchema}".labels AS SELECT id, label FROM "${fixtureSchema}"."values"`);
  // A foreign key to follow: a child points at a parent, one child at nothing.
  await database.query(`CREATE TABLE "${fixtureSchema}".parents (id integer PRIMARY KEY, title text NOT NULL)`);
  await database.query(`CREATE TABLE "${fixtureSchema}".children (id integer PRIMARY KEY, parent_id integer REFERENCES "${fixtureSchema}".parents (id), note text NOT NULL)`);
  await database.query(`INSERT INTO "${fixtureSchema}".parents VALUES (1, 'root'), (2, 'other')`);
  await database.query(`INSERT INTO "${fixtureSchema}".children VALUES (1, 1, 'first'), (2, NULL, 'orphan')`);
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

  test('sorts by several levels from the panel and restores the view from its URL', async ({ page }) => {
    const problems = collectPageErrors(page);
    await openDatabase(page);
    await chooseSchema(page, fixtureSchema);
    await chooseTable(page, fixtureSchema, 'blanks');
    const labels = async () => (await rows(page).allTextContents()).map((text) => /filled|empty-string|sql-null/.exec(text)?.[0]);
    const header = (name: string) => page.getByRole('columnheader').filter({ has: column(page, name) });
    // No sort menu in the header any more: the panel is the one place.
    await column(page, 'grade').click();
    await expect(page.getByRole('menuitem', { name: /Сортировать/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await addSortLevel(page, 'grade', 'asc');
    await addSortLevel(page, 'id', 'desc');
    // grade 1 twice (ids 3 and 2, by id descending), then grade 2.
    await expect.poll(labels).toEqual(['sql-null', 'empty-string', 'filled']);
    await expect(header('grade')).toHaveAttribute('aria-sort', 'ascending');
    await expect(header('id')).toHaveAttribute('aria-sort', 'descending');
    await expect(header('grade').getByTestId('database-sort-level-mark')).toHaveText('1');
    await expect(header('id').getByTestId('database-sort-level-mark')).toHaveText('2');
    // A column one level uses is not offered to another.
    await page.getByRole('combobox', { name: 'Колонка условия 2', exact: true }).click();
    await expect(page.getByRole('option', { name: 'grade', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.getByRole('switch', { name: /^Направление условия 2/ }).click();
    await expect.poll(labels).toEqual(['empty-string', 'sql-null', 'filled']);
    await page.keyboard.press('Escape');
    await expect(sorting(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Сортировка/ })).toHaveText(/Сортировка\s*\(2\)/);
    const address = page.url();
    await page.reload();
    await expect(page.getByRole('heading', { name: `${fixtureSchema}.blanks`, level: 2 })).toBeVisible();
    await expect.poll(labels).toEqual(['empty-string', 'sql-null', 'filled']);
    expect(page.url()).toBe(address);

    await page.getByRole('button', { name: /^Сортировка/ }).click();
    await sorting(page).getByRole('button', { name: 'Очистить всё', exact: true }).click();
    await expect.poll(labels).toEqual(['filled', 'empty-string', 'sql-null']);
    await expect(page.getByRole('button', { name: /^Сортировка/ })).toHaveText('Сортировка');
    expectNoPageErrors(problems);
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

  test('floats the filter panel over the table and closes it on a click outside, keeping the conditions', async ({ page }) => {
    const problems = collectPageErrors(page);
    await openDatabase(page);
    await chooseSchema(page, 'auth');
    await chooseTable(page, 'auth', 'identities');
    const title = page.getByTestId('database-table-title');
    const before = await title.boundingBox();
    await page.getByRole('button', { name: /^Фильтры/ }).click();
    await expect(filters(page)).toBeVisible();
    // The table did not move: the panel floats instead of pushing the page down.
    expect(await title.boundingBox()).toEqual(before);
    await filters(page).getByRole('button', { name: 'Добавить условие', exact: true }).click();
    await page.getByRole('combobox', { name: 'Колонка условия 1', exact: true }).click();
    await page.getByRole('option', { name: 'email', exact: true }).click();
    await filters(page).getByLabel('Значение', { exact: true }).fill('nobody');
    await expect(rows(page).first()).toContainText('Строк нет');
    await page.keyboard.press('Escape');
    await expect(filters(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Фильтры/ })).toHaveText(/Фильтры\s*\(1\)/);
    await expect(rows(page).first()).toContainText('Строк нет');
    await page.getByRole('button', { name: /^Фильтры/ }).click();
    await expect(filters(page).getByLabel('Значение', { exact: true })).toHaveValue('nobody');
    await title.click();
    await expect(filters(page)).toHaveCount(0);
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
    // The filter panel floats as a dialog too; the calendar is the dialog that holds days.
    const calendar = page.getByRole('dialog').filter({ has: page.locator('[data-day]') });

    await page.getByRole('combobox', { name: 'Колонка условия 1', exact: true }).click();
    await page.getByRole('option', { name: 'born', exact: true }).click();
    const value = filters(page).getByLabel('Значение', { exact: true });
    await expect(value).toHaveValue('');
    await page.getByRole('button', { name: 'Календарь: Значение', exact: true }).click();
    await expect(calendar.locator('[data-day]').first()).toBeVisible();
    await expect(page.getByLabel('Время: Значение', { exact: true })).toHaveCount(0);
    await calendar.locator(`[data-day="${first}"] button`).click();
    await expect(value).toHaveValue(first);
    await expect(calendar).toHaveCount(0);

    await page.getByRole('combobox', { name: 'Колонка условия 1', exact: true }).click();
    await page.getByRole('option', { name: 'seen', exact: true }).click();
    await page.getByRole('button', { name: 'Календарь: Значение', exact: true }).click();
    await calendar.locator(`[data-day="${first}"] button`).click();
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
    await calendar.locator(`[data-day="${first}"] button`).click();
    await expect(filters(page).getByLabel('От', { exact: true })).toHaveValue(`${first} 00:00`);
    await expect(calendar).toHaveCount(1);
    await calendar.locator(`[data-day="${first}"] button`).click();
    await expect(filters(page).getByLabel('До', { exact: true })).toHaveValue(`${first} 00:00`);
    await expect(calendar).toHaveCount(0);
    expectNoPageErrors(problems);
  });

  test('keeps the table scrolled where it was while filters change, and starts over on another table', async ({ page }) => {
    const problems = collectPageErrors(page);
    await openDatabase(page);
    await chooseSchema(page, fixtureSchema);
    await chooseTable(page, fixtureSchema, 'values');
    await expect(rows(page).first()).toBeVisible();
    // Eleven columns at 10rem each do not fit the viewport; the table scrolls sideways.
    const scroller = page.getByTestId('database-scroll');
    await scroller.evaluate((element) => { element.scrollLeft = 400; });
    expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(400);

    await page.getByRole('button', { name: /^Фильтры/ }).click();
    await filters(page).getByRole('button', { name: 'Добавить условие', exact: true }).click();
    await page.getByRole('combobox', { name: 'Колонка условия 1', exact: true }).click();
    await page.getByRole('option', { name: 'label', exact: true }).click();
    await page.getByRole('combobox', { name: 'Условие 1', exact: true }).click();
    await page.getByRole('option', { name: 'содержит', exact: true }).click();
    const answered = page.waitForResponse((response) => response.url().includes('/admin/rpc/database.rows'));
    await filters(page).getByLabel('Значение', { exact: true }).fill('cancel');
    await answered;
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('cancel-delete');
    expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(400);
    // The row's actions are pinned to the right edge: still in view after scrolling sideways.
    const pencil = rows(page).first().getByRole('button', { name: 'Открыть строку', exact: true });
    const frame = await scroller.boundingBox();
    const pin = await pencil.boundingBox();
    expect(pin!.x + pin!.width).toBeLessThanOrEqual(frame!.x + frame!.width);
    expect(pin!.x).toBeGreaterThan(frame!.x);
    await scroller.evaluate((element) => { element.scrollLeft = 0; });
    const pinAtStart = await pencil.boundingBox();
    expect(Math.round(pinAtStart!.x)).toBe(Math.round(pin!.x));
    await scroller.evaluate((element) => { element.scrollLeft = 400; });

    await chooseTable(page, fixtureSchema, 'blanks');
    await expect(rows(page).first()).toBeVisible();
    expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(0);
    expectNoPageErrors(problems);
  });

  test('keeps the column names and lit row actions in view while the rows scroll', async ({ page }) => {
    await database.query(`CREATE TABLE "${fixtureSchema}".tall (id integer PRIMARY KEY, label text NOT NULL)`);
    await database.query(`INSERT INTO "${fixtureSchema}".tall SELECT g, 'row ' || g FROM generate_series(1, 40) g`);
    await openDatabase(page);
    await chooseSchema(page, fixtureSchema);
    await chooseTable(page, fixtureSchema, 'tall');
    await page.getByRole('combobox', { name: 'Строк на странице', exact: true }).click();
    await page.getByRole('option', { name: '50 строк', exact: true }).click();
    await expect(rows(page)).toHaveCount(40);
    const scroller = page.getByTestId('database-scroll');
    await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const [top, header] = [await scroller.boundingBox(), await page.getByTestId('database-table').locator('thead').boundingBox()];
    expect(Math.abs(header!.y - top!.y)).toBeLessThanOrEqual(2);
    // The hover tint lies under the row's buttons, not over them.
    const last = rows(page).last();
    await last.hover();
    const pencil = last.getByRole('button', { name: 'Открыть строку', exact: true });
    await expect.poll(() => pencil.evaluate((button) => {
      const cell = button.closest('td')!;
      const layer = (value: string) => (value === 'auto' ? 0 : Number(value));
      const tint = getComputedStyle(cell, '::after');
      return tint.opacity === '1' && layer(getComputedStyle(button.parentElement!).zIndex) > layer(tint.zIndex);
    })).toBe(true);
  });

  test('shows where a dragged condition will land and drops it there', async ({ page }) => {
    const problems = collectPageErrors(page);
    await openDatabase(page);
    await chooseSchema(page, fixtureSchema);
    await chooseTable(page, fixtureSchema, 'blanks');
    await page.getByRole('button', { name: /^Фильтры/ }).click();
    for (const condition of ['пустая строка', 'пусто']) {
      await filters(page).getByRole('button', { name: 'Добавить условие', exact: true }).click();
      const at = (await page.getByTestId('database-filter').count());
      await page.getByRole('combobox', { name: `Колонка условия ${at}`, exact: true }).click();
      await page.getByRole('option', { name: 'blank', exact: true }).click();
      await page.getByRole('combobox', { name: `Условие ${at}`, exact: true }).click();
      await page.getByRole('option', { name: condition, exact: true }).click();
    }
    const handle = page.getByRole('button', { name: 'Переместить условие 2', exact: true });
    const target = page.getByTestId('database-filter').first();
    const slot = page.getByTestId('database-filter-drop');
    // The HTML5 drag sequence by hand: start on the handle, hover the first row, drop there.
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await handle.dispatchEvent('dragstart', { dataTransfer });
    await expect(slot).toHaveCount(0);
    await target.dispatchEvent('dragover', { dataTransfer });
    await expect(slot).toHaveCount(1);
    // Coming from below, the slot is drawn above the hovered row.
    const slotBox = await slot.boundingBox();
    const targetBox = await target.boundingBox();
    expect(slotBox!.y).toBeLessThan(targetBox!.y);
    await target.dispatchEvent('drop', { dataTransfer });
    await handle.dispatchEvent('dragend', { dataTransfer });
    await expect(slot).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Условие 1', exact: true })).toHaveText('пусто');
    await expect(page.getByRole('combobox', { name: 'Условие 2', exact: true })).toHaveText('пустая строка');
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
    // The switch's hint floats over the switch, not over the middle of the panel.
    const caseSwitch = page.getByRole('checkbox', { name: 'Учитывать регистр', exact: true });
    await caseSwitch.hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
    const [box, hint] = [await caseSwitch.boundingBox(), await page.locator('[data-slot="tooltip-content"]').boundingBox()];
    expect(hint!.x).toBeLessThanOrEqual(box!.x + box!.width);
    expect(hint!.x + hint!.width).toBeGreaterThanOrEqual(box!.x);
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
    await expect(create.getByLabel('created_at', { exact: true })).toHaveAttribute('placeholder', 'По умолчанию');
    await create.getByLabel('id', { exact: true }).fill(crypto.randomUUID());
    await create.getByLabel('action', { exact: true }).fill(action);
    await create.getByRole('button', { name: 'Добавить', exact: true }).click();
    await expect(create).toBeHidden();
    await addSortLevel(page, 'created_at', 'desc');
    await page.keyboard.press('Escape');
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
    // Hiding from the header opens the visibility panel with that column already unticked.
    await page.getByRole('menuitem', { name: 'Скрыть колонку', exact: true }).click();
    await expect(column(page, 'email')).toHaveCount(0);
    const visibility = page.getByRole('region', { name: 'Видимость колонок' });
    await expect(visibility).toBeVisible();
    await expect(visibility.getByRole('checkbox', { name: 'Показывать email', exact: true })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('button', { name: /^Видимость/ })).toHaveText(/\(1 скрыто\)/);
    await visibility.getByRole('checkbox', { name: 'Показывать id', exact: true }).click();
    await expect(column(page, 'id')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Видимость/ })).toHaveText(/\(2 скрыто\)/);
    const address = page.url();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'auth.identities', level: 2 })).toBeVisible();
    await expect(column(page, 'email')).toHaveCount(0);
    expect(page.url()).toBe(address);

    await page.getByRole('button', { name: /^Видимость/ }).click();
    await visibility.getByRole('checkbox', { name: 'Показывать id', exact: true }).click();
    await expect(column(page, 'id')).toBeVisible();
    await visibility.getByRole('button', { name: 'Показать все', exact: true }).click();
    await expect(column(page, 'email')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Видимость/ })).toHaveText('Видимость');
    await expect(visibility.getByRole('button', { name: 'Показать все', exact: true })).toHaveCount(0);
    // The last visible column stays: its box is disabled.
    const boxes = visibility.getByRole('checkbox');
    for (let at = (await boxes.count()) - 1; at > 0; at--) await boxes.nth(at).click();
    await expect(boxes.first()).toHaveAttribute('aria-checked', 'true');
    await expect(boxes.first()).toBeDisabled();
    await visibility.getByRole('button', { name: 'Показать все', exact: true }).click();
  });

  test('lists a view beside the tables and opens it read-only', async ({ page }) => {
    await openDatabase(page);
    await chooseSchema(page, fixtureSchema);
    const entry = page.getByRole('button', { name: `Открыть представление ${fixtureSchema}.labels`, exact: true });
    await expect(entry).toBeVisible();
    // Under its own heading, after the schema's tables.
    const list = page.getByRole('navigation', { name: `Таблицы ${fixtureSchema}`, exact: true });
    await expect(list.getByText('Представления', { exact: true })).toBeVisible();
    const heading = await list.getByText('Представления', { exact: true }).boundingBox();
    const lastTable = await page.getByRole('button', { name: `Открыть таблицу ${fixtureSchema}.values`, exact: true }).boundingBox();
    const view = await entry.boundingBox();
    expect(heading!.y).toBeGreaterThan(lastTable!.y);
    expect(view!.y).toBeGreaterThan(heading!.y);
    await entry.click();
    await expect(page.getByRole('heading', { name: `${fixtureSchema}.labels`, level: 2 })).toBeVisible();
    await expect(rows(page).first()).toContainText('cancel-delete');
    await expect(page.getByRole('status')).toContainText('Представление — только чтение');
    await expect(page.getByRole('button', { name: 'Добавить строку', exact: true })).toBeDisabled();
    // Reading works as on a table: a filter narrows the rows.
    await page.getByRole('button', { name: /^Фильтры/ }).click();
    await filters(page).getByRole('button', { name: 'Добавить условие', exact: true }).click();
    await page.getByRole('combobox', { name: 'Колонка условия 1', exact: true }).click();
    await page.getByRole('option', { name: 'label', exact: true }).click();
    await page.getByRole('combobox', { name: 'Условие 1', exact: true }).click();
    await page.getByRole('option', { name: 'содержит', exact: true }).click();
    const answered = page.waitForResponse((response) => response.url().includes('/admin/rpc/database.rows'));
    await filters(page).getByLabel('Значение', { exact: true }).fill('no-such-label');
    await answered;
    await expect(rows(page).first()).toContainText('Строк нет');
  });

  test('follows a foreign key from the cell and the row dialog to the row it points at', async ({ page }) => {
    await openFixture(page, 'children');
    // The header tells where the column points; the cell's arrow goes there.
    await page.getByLabel(`Ссылается на ${fixtureSchema}.parents.id`).hover();
    await expect(page.getByRole('tooltip')).toContainText(`Ссылается на ${fixtureSchema}.parents.id`);
    const first = rows(page).filter({ hasText: 'first' });
    const orphan = rows(page).filter({ hasText: 'orphan' });
    await expect(first.getByRole('button', { name: `Открыть ${fixtureSchema}.parents по parent_id`, exact: true })).toBeVisible();
    await expect(orphan.getByRole('button', { name: `Открыть ${fixtureSchema}.parents по parent_id`, exact: true })).toHaveCount(0);
    // Clicking the value still copies, not navigates.
    await first.locator('[data-testid="database-cell"][data-column="parent_id"]').click();
    await expect(page.getByRole('heading', { name: `${fixtureSchema}.children`, level: 2 })).toBeVisible();
    await first.getByRole('button', { name: `Открыть ${fixtureSchema}.parents по parent_id`, exact: true }).click();
    await expect(page.getByRole('heading', { name: `${fixtureSchema}.parents`, level: 2 })).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('root');
    await expect(page.getByRole('button', { name: /^Фильтры/ })).toHaveText(/Фильтры\s*\(1\)/);
    // The target says who points at it.
    await page.getByLabel('На эту таблицу ссылаются', { exact: true }).hover();
    await expect(page.getByRole('tooltip')).toContainText(`${fixtureSchema}.children.parent_id`);

    // From the row dialog: the arrow is there with a value, and held back while something is unsaved.
    await openFixture(page, 'children');
    await rows(page).filter({ hasText: 'first' }).getByRole('button', { name: 'Открыть строку', exact: true }).click();
    const arrow = editor(page).getByRole('button', { name: `Открыть ${fixtureSchema}.parents по parent_id`, exact: true });
    await expect(arrow).toBeEnabled();
    await editor(page).getByLabel('note', { exact: true }).fill('first-edited');
    await expect(arrow).toBeDisabled();
    await editor(page).getByLabel('note', { exact: true }).fill('first');
    await expect(arrow).toBeEnabled();
    await arrow.click();
    await expect(editor(page)).toBeHidden();
    await expect(page.getByRole('heading', { name: `${fixtureSchema}.parents`, level: 2 })).toBeVisible();
    await expect(rows(page)).toHaveCount(1);

    // A new row has nothing saved to follow from, so its dialog offers no arrow.
    await openFixture(page, 'children');
    await page.getByRole('button', { name: 'Добавить строку', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'Новая строка', exact: true });
    await create.getByLabel('parent_id', { exact: true }).fill('1');
    await expect(create.getByRole('button', { name: `Открыть ${fixtureSchema}.parents по parent_id`, exact: true })).toHaveCount(0);
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

/** Opens the settings popover of a field in the row dialog: its mode and escaping live there. */
async function fieldSettings(dialog: Locator, column: string) {
  const page = dialog.page();
  const panel = page.getByRole('dialog', { name: `Настройки ${column}`, exact: true });
  if (await panel.count() === 0) await dialog.getByRole('button', { name: `Настройки ${column}`, exact: true }).click();
  await expect(panel).toBeVisible();
  return panel;
}

async function setMode(dialog: Locator, column: string, mode: 'Значение' | 'SQL NULL' | 'По умолчанию') {
  const panel = await fieldSettings(dialog, column);
  await panel.getByRole('radio', { name: mode, exact: true }).check();
  await dialog.page().keyboard.press('Escape');
  await expect(panel).toBeHidden();
}

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
      // The reason sits behind a lock beside the name: no text in the field, the text on hovering the lock.
      const idField = create.locator('[data-testid="database-field"][data-column="id"]');
      await expect(idField).not.toContainText('Только чтение');
      await idField.getByLabel(/^Только чтение/).hover();
      await expect(page.getByRole('tooltip')).toContainText('PostgreSQL назначит значение при сохранении');
      await create.getByLabel('label', { exact: true }).hover();
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

  test('spells control characters out in the cell and its preview', async ({ page }) => {
    await database.query(`INSERT INTO "${fixtureSchema}"."values" (id, label, controls) VALUES (63, 'spelled-controls', $1)`, ['first\r\nsecond\tend']);
    await openFixture(page);
    const cell = rows(page).filter({ hasText: 'spelled-controls' }).locator('[data-testid="database-cell"][data-column="controls"]');
    // The cell shows the bytes the search would have to match, not a space where the browser swallowed the line break.
    await expect(cell).toHaveText('first\\r\\nsecond\\tend');
    await expect(cell.locator('[data-control]')).toHaveText(['\\r', '\\n', '\\t']);
    await cell.hover();
    const preview = page.getByTestId('database-value-preview').locator('pre');
    await expect(preview).toHaveText('first\\r\\n\nsecond\\tend');
    await expect(preview.locator('[data-control]')).toHaveCount(3);
    // The spelling is display only: the stored bytes are untouched.
    expect((await storedRow(63))?.controls).toBe('first\r\nsecond\tend');
  });

  test('finds a row by a condition typed the way the cell spells it', async ({ page }) => {
    await database.query(`INSERT INTO "${fixtureSchema}"."values" (id, label, controls) VALUES (64, 'spelled-filter', $1), (65, 'spelled-decoy', $2)`, ['first line\r\nsecond line', 'first line\\r\\nsecond line']);
    await openFixture(page);
    await page.getByRole('button', { name: /^Фильтры/ }).click();
    await filters(page).getByRole('button', { name: 'Добавить условие', exact: true }).click();
    await page.getByRole('combobox', { name: 'Колонка условия 1', exact: true }).click();
    await page.getByRole('option', { name: 'controls', exact: true }).click();
    await page.getByRole('combobox', { name: 'Условие 1', exact: true }).click();
    await page.getByRole('option', { name: 'содержит', exact: true }).click();
    let answered = page.waitForResponse((response) => response.url().includes('/admin/rpc/database.rows'));
    await filters(page).getByLabel('Значение', { exact: true }).fill('line\\r\\nsecond');
    await answered;
    // `\r\n` means the two characters, as the cell shows them; the decoy holds four and is not it.
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('spelled-filter');
    // The address keeps the spelling, so a reload asks the same thing.
    const view = JSON.parse(decodeURIComponent(new URL(page.url()).hash.slice(1))) as { filters: { value: unknown }[] };
    expect(view.filters[0]?.value).toBe('line\\r\\nsecond');
    // `\\` is one backslash: that finds the decoy, which has the spelling as plain text.
    answered = page.waitForResponse((response) => response.url().includes('/admin/rpc/database.rows'));
    await filters(page).getByLabel('Значение', { exact: true }).fill('line\\\\r\\\\nsecond');
    await answered;
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('spelled-decoy');
    // What a cell copies (the bytes) pasted into the box lands as the spelling, not as nothing.
    answered = page.waitForResponse((response) => response.url().includes('/admin/rpc/database.rows'));
    await filters(page).getByLabel('Значение', { exact: true }).evaluate((element) => {
      const input = element as HTMLInputElement;
      input.focus();
      input.setSelectionRange(0, input.value.length);
      const data = new DataTransfer();
      data.setData('text/plain', 'first line\r\nsecond line');
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(filters(page).getByLabel('Значение', { exact: true })).toHaveValue('first line\\r\\nsecond line');
    await answered;
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('spelled-filter');
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
    // The dialog opens typing into its first box, not on a settings icon; nothing pops up by itself.
    await expect(create.getByLabel('id', { exact: true })).toBeFocused();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: /^Настройки/ })).toHaveCount(0);
    await create.getByLabel('id', { exact: true }).fill('10');
    await create.getByLabel('label', { exact: true }).fill('explicit-states');
    await setMode(create, 'blank', 'Значение');
    await create.getByLabel('blank', { exact: true }).fill('');
    await setMode(create, 'literal', 'Значение');
    await create.getByLabel('literal', { exact: true }).fill('null');
    await expect(create.getByLabel('fallback', { exact: true })).toHaveAttribute('placeholder', 'По умолчанию');
    // The icon says so without opening anything, and the dialog itself survives the panel's Escape.
    await expect(create.getByRole('button', { name: 'Настройки fallback', exact: true })).toHaveAttribute('data-set', 'true');
    await expect(create.getByRole('button', { name: 'Настройки literal', exact: true })).not.toHaveAttribute('data-set', 'true');
    await expect(create).toBeVisible();
    await create.getByRole('button', { name: 'Добавить', exact: true }).click();
    await expect(create).toBeHidden();
    expect(await storedRow(10)).toMatchObject({ blank: '', literal: 'null', fallback: 'database default', precise: null });

    const row = rows(page).filter({ hasText: 'explicit-states' });
    await row.getByRole('button', { name: 'Открыть строку', exact: true }).click();
    await setMode(editor(page), 'blank', 'SQL NULL');
    await expect(editor(page).getByLabel('blank', { exact: true })).toHaveAttribute('placeholder', 'SQL NULL');
    await setMode(editor(page), 'fallback', 'Значение');
    await editor(page).getByLabel('fallback', { exact: true }).fill('');
    await editor(page).getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(editor(page)).toBeHidden();
    expect(await storedRow(10)).toMatchObject({ blank: null, literal: 'null', fallback: '' });

    await row.getByRole('button', { name: 'Открыть строку', exact: true }).click();
    await setMode(editor(page), 'blank', 'Значение');
    await editor(page).getByLabel('blank', { exact: true }).fill('');
    await editor(page).getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(editor(page)).toBeHidden();
    expect(await storedRow(10)).toMatchObject({ blank: '', literal: 'null', fallback: '' });
  });

  test('types into a NULL box by clicking it, while a stray click leaves NULL alone', async ({ page }) => {
    await openFixture(page);
    await page.getByRole('button', { name: 'Добавить строку', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'Новая строка', exact: true });
    await create.getByLabel('id', { exact: true }).fill('11');
    await create.getByLabel('label', { exact: true }).fill('clicked-in');
    // A nullable box starts as SQL NULL; clicking into it is enough to type a value.
    const blank = create.getByLabel('blank', { exact: true });
    await expect(blank).toHaveAttribute('placeholder', 'SQL NULL');
    await expect(blank).toBeEnabled();
    await blank.click();
    await expect(blank).not.toHaveAttribute('placeholder', 'SQL NULL');
    await blank.fill('typed');
    // Clicking into another one and leaving it empty puts SQL NULL back.
    const literal = create.getByLabel('literal', { exact: true });
    await literal.click();
    await expect(literal).not.toHaveAttribute('placeholder', 'SQL NULL');
    await create.getByLabel('label', { exact: true }).click();
    await expect(literal).toHaveAttribute('placeholder', 'SQL NULL');
    await create.getByRole('button', { name: 'Добавить', exact: true }).click();
    await expect(create).toBeHidden();
    expect(await storedRow(11)).toMatchObject({ blank: 'typed', literal: null });

    // On an existing row the same stray click does not even enable saving.
    await rows(page).filter({ hasText: 'clicked-in' }).getByRole('button', { name: 'Открыть строку', exact: true }).click();
    await editor(page).getByLabel('literal', { exact: true }).click();
    await expect(editor(page).getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();
    await editor(page).getByLabel('label', { exact: true }).click();
    await expect(editor(page).getByLabel('literal', { exact: true })).toHaveAttribute('placeholder', 'SQL NULL');
    await expect(editor(page).getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();
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

    const documentSettings = await fieldSettings(editor(page), 'document');
    await documentSettings.getByRole('checkbox', { name: 'Экранировать спецсимволы', exact: true }).check();
    await expect(editor(page).getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();
    await expect(editor(page).getByRole('button', { name: 'Настройки document', exact: true })).toHaveAttribute('data-set', 'true');
    await documentSettings.getByRole('checkbox', { name: 'Экранировать спецсимволы', exact: true }).uncheck();
    await page.keyboard.press('Escape');
    await expect(documentSettings).toBeHidden();
    await expect(editor(page)).toBeVisible();
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
