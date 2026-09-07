import { fileURLToPath } from 'node:url';

import { expect, test, type FrameLocator, type Page } from '@playwright/test';

import { collectPageErrors, expectNoPageErrors, signIn } from './support.js';

/**
 * The panel's database section: the tables of every module's database, and one page of rows.
 *
 * The section used to be a third-party console; it is this template's own screen now, so what these
 * checks are about is different too. Not "is it the real Adminer" but: does it read the catalogue of a
 * live database, does the key of a row come from the catalogue rather than from a column called `id`,
 * and does the theme of the panel reach a frame that is not React.
 */

/** The screen, inside the frame the panel embeds it in. */
async function openDatabaseSection(page: Page): Promise<FrameLocator> {
  await signIn(page);
  await page.goto('/admin/database');

  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.shell-table').first()).toBeVisible({ timeout: 20_000 });
  return frame;
}

/** Switches the database and waits for its tables, which are a different set. */
async function chooseDatabase(page: Page, frame: FrameLocator, matching: RegExp): Promise<void> {
  await frame.locator('.shell-database').click();
  await frame.locator('.el-select-dropdown__item').filter({ hasText: matching }).first().click();
}

/**
 * Refuses to change a shape against a copy that would write into this repository.
 *
 * A column added from the screen is written as a migration into a project's sources — that is the
 * whole point of it — so a suite that adds and drops columns has to be pointed somewhere else, with
 * `SCHEMA_SOURCE_ROOT`. Without this, every run would leave two migrations behind in the repository it
 * was testing, and nothing would say so.
 *
 * Asked after signing in, not before: the section is the owner's, and an unauthenticated request is
 * refused by Gateway — which answers no `writesInto` at all, and so passes this silently. Measured.
 */
async function refuseToWriteIntoTheRepository(page: Page): Promise<void> {
  const response = await page.request.get('/admin/embed/database/api/databases');
  const { writesInto } = (await response.json()) as { writesInto: string | null };

  const advice =
    'Start it with SCHEMA_SOURCE_ROOT pointing at a scratch copy of modules/*/src/db/migrations.';

  // Nowhere to write at all: the screen offers no column button, and waiting for one is a timeout
  // that says nothing. Better to fail here, naming what is missing.
  expect(writesInto, `This copy cannot change the shape of a table. ${advice}`).not.toBeNull();

  const repository = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
  expect(
    writesInto,
    `This copy would write migrations into the repository under test. ${advice}`,
  ).not.toBe(repository);
}

test.describe('the database section', () => {
  test('reads the catalogue of a live database', async ({ page }) => {
    const problems = collectPageErrors(page);
    const frame = await openDatabaseSection(page);

    await chooseDatabase(page, frame, /_auth$/);
    await expect(frame.locator('.shell-table-name').filter({ hasText: 'identities' })).toBeVisible();

    await frame.locator('.shell-table-name').filter({ hasText: 'identities' }).click();
    await expect(frame.locator('.el-table__row').first()).toBeVisible({ timeout: 20_000 });

    // The columns are named by the database, with the type the catalogue reports beside each one.
    await expect(frame.locator('.column-head').filter({ hasText: /^email\s/ }).first()).toBeVisible();
    await expect(frame.locator('.column-head').filter({ hasText: 'uuid' }).first()).toBeVisible();

    expectNoPageErrors(problems);
  });

  test('sorts through the column menu and keeps the view in the address', async ({ page }) => {
    const frame = await openDatabaseSection(page);

    await chooseDatabase(page, frame, /_auth$/);
    await frame.locator('.shell-table-name').filter({ hasText: 'identities' }).click();
    await expect(frame.locator('.el-table__row').first()).toBeVisible({ timeout: 20_000 });

    await frame.locator('.column-head').filter({ hasText: /^email\s/ }).first().click();
    await frame
      .locator('.el-dropdown-menu__item:visible')
      .filter({ hasText: 'Сортировать' })
      .first()
      .click();

    await expect(frame.locator('.column-sort').first()).toHaveText('↑');

    /*
     * The view is in the frame's own URL, which is what makes a link to a filtered table sendable.
     * There is nowhere to store named views: this interface creates no table of its own.
     */
    const inner = page.frames().at(-1)?.url() ?? '';
    expect(inner).toContain('#');
  });

  /**
   * A table shows a line of a value, and a hash or a json document is longer than the line. Hovering
   * the cell is how the rest of it is seen — and the check is that what appears is the whole value, not
   * the truncated text the cell was showing.
   */
  test('shows a cut value in full when the cell is hovered', async ({ page }) => {
    const frame = await openDatabaseSection(page);

    await chooseDatabase(page, frame, /_auth$/);
    await frame.locator('.shell-table-name').filter({ hasText: 'identities' }).click();
    await expect(frame.locator('.el-table__row').first()).toBeVisible({ timeout: 20_000 });

    const cell = frame.locator('.el-table__row .value-cell').first();
    const shown = ((await cell.textContent()) ?? '').trim();
    await cell.hover();

    /*
     * Hovering is the whole gesture, and nothing inside is interactive: a popover that appears while the
     * pointer crosses a table cannot hold buttons — it would be gone before one could be reached.
     */
    const full = frame.locator('.value-popover .value');
    await expect(full).toBeVisible();
    await expect(full).toHaveText(shown);
    await expect(frame.locator('.value-popover button')).toHaveCount(0);
    // The name of the column it came from, so a value out of context is still identifiable.
    await expect(frame.locator('.value-popover .head-name')).toHaveText('id');

    /*
     * A popover, not a modal: the row stays readable beside it, so one value can be compared with the
     * one under it. The dimming layer a dialog puts over the table is what must not be there — and it is
     * `:visible` that matters, because the row and column dialogs keep a hidden overlay in the DOM.
     */
    await expect(frame.locator('.el-overlay:visible')).toHaveCount(0);
    await expect(frame.locator('.el-table__row').first()).toBeVisible();

    // Moving away takes it away. Hidden, not removed: element-plus keeps the popper in the DOM, so this
    // asks whether it is on screen rather than whether it exists.
    await frame.locator('.head-title').hover();
    await expect(frame.locator('.value-popover:visible')).toHaveCount(0);
  });

  /**
   * Clicking a cell copies its whole value, not the line the cell had room for.
   *
   * Two paths lead there and both matter: the clipboard API when the frame is allowed it, and
   * `execCommand` when it is not — inside an embedded frame the first one is often refused, and without
   * the fallback a click did nothing at all. What the test can check is the first path; the second is why
   * the message appears either way.
   */
  test('copies the whole value when a cell is clicked', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const frame = await openDatabaseSection(page);

    await chooseDatabase(page, frame, /_auth$/);
    await frame.locator('.shell-table-name').filter({ hasText: 'identities' }).click();
    await expect(frame.locator('.el-table__row').first()).toBeVisible({ timeout: 20_000 });

    // The password hash: longer than its cell, which is the case worth checking.
    const cell = frame.locator('.el-table__row').first().locator('.value-cell').nth(3);
    await cell.scrollIntoViewIfNeeded();
    await cell.click();

    await expect(frame.locator('.el-message')).toContainText('скопировано');

    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/^scrypt\$/);
    expect(copied.length).toBeGreaterThan(60);
  });

  /** A json value is a document: one line in the cell, indented in the popover. */
  test('indents a json value when it is shown in full', async ({ page }) => {
    const frame = await openDatabaseSection(page);

    await chooseDatabase(page, frame, /_admin$/);
    await frame.locator('.shell-table-name').filter({ hasText: /^admin_audit$/ }).click();
    await expect(frame.locator('.el-table__row').first()).toBeVisible({ timeout: 20_000 });

    const cell = frame
      .locator('.el-table__row')
      .first()
      .locator('.value-cell')
      .filter({ hasText: '{' })
      .first();
    await cell.scrollIntoViewIfNeeded();
    await cell.hover();

    await expect(frame.locator('.value-popover .value')).toContainText('\n  ');
  });

  /**
   * A filter with nothing typed in it must not be asked. Adding a condition is what sends the view to
   * the server, and the new filter starts empty — so an empty value went to a uuid column and PostgreSQL
   * answered `invalid input syntax for type uuid: ""`. An error message for doing nothing but adding a
   * row to a form. The count on the button says how many filters are really being asked, which is how a
   * half-filled one is visibly not one of them.
   */
  test('adds an empty filter without asking anything yet', async ({ page }) => {
    const problems = collectPageErrors(page);
    const frame = await openDatabaseSection(page);

    await chooseDatabase(page, frame, /_auth$/);
    await frame.locator('.shell-table-name').filter({ hasText: 'identities' }).click();
    await expect(frame.locator('.el-table__row').first()).toBeVisible({ timeout: 20_000 });

    await frame.locator('.filters-button').click();
    await frame.locator('.filters-add').click();

    // The filter is in the panel, the rows are still there, and nothing was refused.
    await expect(frame.locator('.filters-row')).toHaveCount(1);
    await expect(frame.locator('.el-table__row').first()).toBeVisible();
    await expect(frame.locator('.el-message--error')).toHaveCount(0);
    await expect(frame.locator('.filters-button')).toHaveText('Фильтры');

    // Filling it in does ask, and the count then says one. The column is switched to a text one first:
    // a filter starts on the first column, which here is a uuid, and `probe` is not a uuid.
    await frame.locator('.filters-column').click();
    await frame.locator('.el-select-dropdown__item:visible').filter({ hasText: 'email' }).first().click();
    await frame.locator('.filters-value input').fill('probe');

    await expect(frame.locator('.filters-button')).toHaveText('Фильтры 1');
    await expect(frame.locator('.el-message--error')).toHaveCount(0);

    expectNoPageErrors(problems);
  });

  /**
   * Dropping every condition at once, which is how people stop filtering. The button appears only when
   * there is something to clear: one that is always there and does nothing reads as broken.
   */
  test('clears every filter at once', async ({ page }) => {
    const problems = collectPageErrors(page);
    const frame = await openDatabaseSection(page);

    await chooseDatabase(page, frame, /_auth$/);
    await frame.locator('.shell-table-name').filter({ hasText: 'identities' }).click();
    await expect(frame.locator('.el-table__row').first()).toBeVisible({ timeout: 20_000 });

    await frame.locator('.filters-button').click();
    await expect(frame.locator('.filters-clear')).toHaveCount(0);

    await frame.locator('.filters-add').click();
    await frame.locator('.filters-column').click();
    await frame.locator('.el-select-dropdown__item:visible').filter({ hasText: 'email' }).first().click();
    await frame.locator('.filters-value input').fill('probe');
    await expect(frame.locator('.filters-button')).toHaveText('Фильтры 1');

    await frame.locator('.filters-add').click();
    await expect(frame.locator('.filters-row')).toHaveCount(2);

    // Outlined in the colour of deleting: it throws away conditions somebody assembled.
    await expect(frame.locator('.filters-clear')).toHaveClass(/el-button--danger/);

    /*
     * And kept at the far edge rather than next to "Добавить условие". Two buttons side by side make
     * one a misclick away from the other, and here that misclick costs every condition. The right
     * edges of the button and of a filter row are the same line, which is what "at the far edge" means.
     */
    const clearBox = await frame.locator('.filters-clear').boundingBox();
    const rowBox = await frame.locator('.filters-row').first().boundingBox();
    expect(clearBox).not.toBeNull();
    expect(rowBox).not.toBeNull();
    if (clearBox && rowBox) {
      expect(Math.abs(clearBox.x + clearBox.width - (rowBox.x + rowBox.width))).toBeLessThan(4);
    }

    await frame.locator('.filters-clear').click();

    await expect(frame.locator('.filters-row')).toHaveCount(0);
    await expect(frame.locator('.filters-button')).toHaveText('Фильтры');
    await expect(frame.locator('.filters-clear')).toHaveCount(0);
    // The panel stays open, and the rows came back rather than an error.
    await expect(frame.locator('.filters-add')).toBeVisible();
    await expect(frame.locator('.el-table__row').first()).toBeVisible({ timeout: 20_000 });
    await expect(frame.locator('.el-message--error')).toHaveCount(0);

    expectNoPageErrors(problems);
  });

  /**
   * The conditions a column is offered, and the panel staying open while one is chosen.
   *
   * Both are checks against the same class of fault. The condition list is built from the rows answer,
   * and it was empty because only the table list carried it — every filter fell back to "is". And every
   * dropdown inside the panel is `teleported: false`, because element-plus renders one at the end of the
   * document by default, which the popover reads as a click outside and closes itself: choosing a column
   * shut the panel before a condition could be picked.
   */
  test('offers conditions that fit the column, and stays open while one is chosen', async ({ page }) => {
    const problems = collectPageErrors(page);
    const frame = await openDatabaseSection(page);

    await chooseDatabase(page, frame, /_admin$/);
    await frame.locator('.shell-table-name').filter({ hasText: /^administrators$/ }).click();
    await expect(frame.locator('.el-table__row').first()).toBeVisible({ timeout: 20_000 });

    await frame.locator('.filters-button').click();
    await frame.locator('.filters-add').click();

    // A boolean is asked about truth, and never about being greater than something.
    await frame.locator('.filters-column .el-select__wrapper').click();
    await frame
      .locator('.el-select-dropdown__item:visible')
      .filter({ hasText: /^enabled$/ })
      .first()
      .click();

    await frame.locator('.filters-condition .el-select__wrapper').click();
    const offered = frame.locator('.el-select-dropdown__item:visible');
    await expect(offered.filter({ hasText: /^да$/ })).toBeVisible();
    await expect(offered.filter({ hasText: 'больше' })).toHaveCount(0);

    // Choosing it leaves the panel open — the whole point of the teleport setting.
    await offered.filter({ hasText: /^нет$/ }).first().click();
    await expect(frame.locator('.filters-row')).toHaveCount(1);
    await expect(frame.locator('.filters-button')).toHaveText('Фильтры 1');

    // A range asks for two ends, and asks nothing until it has both.
    await frame.locator('.filters-column .el-select__wrapper').click();
    await frame
      .locator('.el-select-dropdown__item:visible')
      .filter({ hasText: /^created_at$/ })
      .first()
      .click();
    await frame.locator('.filters-condition .el-select__wrapper').click();
    await frame.locator('.el-select-dropdown__item:visible').filter({ hasText: 'между' }).first().click();

    await expect(frame.locator('.filters-range input')).toHaveCount(2);
    await expect(frame.locator('.filters-button')).toHaveText('Фильтры');

    expectNoPageErrors(problems);
  });

  /**
   * Deleting a row is a button, not a menu: what guards against a misclick is the question, not the
   * hiding. This checks the question and answers no, so the stand keeps its rows.
   */
  test('asks before deleting a row, from a button in the row', async ({ page }) => {
    const frame = await openDatabaseSection(page);

    await chooseDatabase(page, frame, /_admin$/);
    await frame.locator('.shell-table-name').filter({ hasText: /^administrators$/ }).click();
    await expect(frame.locator('.el-table__row').first()).toBeVisible({ timeout: 20_000 });

    const rows = await frame.locator('.el-table__row').count();
    const actions = frame.locator('.el-table__row').first().locator('.actions button');
    await expect(actions).toHaveCount(2);

    /*
     * Both actions are icons without labels, two pixels apart, and a misclick between them costs very
     * different things. So the one under the pointer is lit in its own colour — red for deleting.
     *
     * Measured rather than eyeballed, and measured as a *tint*: element-plus lights a text button by
     * itself, but with `rgb(245, 247, 250)`, which on a row that is already grey under the pointer is
     * invisible — and, worse, says nothing about which of the two buttons it is. So the claim is not
     * "a background appears" (that passes without any of our styling) but "the background is red".
     */
    /*
     * The pointer stays a pointer across the whole cell. The buttons are fourteen pixels apart — two of
     * ours and twelve from the library's own `.el-button + .el-button` — and on that strip the cursor
     * used to fall back to an arrow, so moving between the two icons made it flicker.
     */
    const actionsCell = frame.locator('.el-table__row').first().locator('.actions');
    expect(await actionsCell.evaluate((node) => getComputedStyle(node).cursor)).toBe('pointer');

    const remove = frame.locator('.el-table__row').first().locator('.actions-delete');
    const redness = () =>
      remove.evaluate((node) => {
        const [red = 0, green = 0, blue = 0] = (getComputedStyle(node).backgroundColor.match(/\d+/g) ?? [])
          .slice(0, 3)
          .map(Number);
        return red - Math.max(green, blue);
      });

    expect(await redness()).toBe(0);

    await remove.hover();
    await expect.poll(async () => await redness(), { timeout: 5_000 }).toBeGreaterThan(10);

    await frame.locator('.el-table__row').first().locator('.actions-delete').click();
    await expect(frame.locator('.el-message-box__message')).toContainText('нельзя отменить');

    // No: the row stays, which is what makes this test safe to run against a live stand.
    await frame.locator('.el-message-box__btns button').filter({ hasText: 'Отмена' }).click();
    await expect(frame.locator('.el-table__row')).toHaveCount(rows);
  });

  /**
   * A table whose key is two columns is the case a screen gets wrong: addressing a row by `id` would
   * either fail or, worse, match several rows. This one exists in the admin database.
   */
  /**
   * A new row, and what the form decides for the person.
   *
   * `auth_audit` is the table this is done in on purpose: its key has no default, so the form has to
   * ask for it, while `details` and `created_at` have defaults and must not be sent empty — an empty
   * value would be stored instead of the default. The row is removed again at the end, so the check is
   * safe to run against a live stand.
   */
  test('adds a row, letting the database fill in what it fills in', async ({ page }) => {
    const problems = collectPageErrors(page);
    const frame = await openDatabaseSection(page);

    await chooseDatabase(page, frame, /_auth$/);
    await frame.locator('.shell-table-name').filter({ hasText: /^auth_audit$/ }).click();
    await expect(frame.locator('.el-table__row').first()).toBeVisible({ timeout: 20_000 });

    const id = crypto.randomUUID();
    const action = `probe.inserted.${Date.now()}`;

    /*
     * The count beside the table name, which the screen keeps in step itself. Asking the server again
     * would mean counting the rows of every table in the database — the most expensive read here.
     */
    const sidebarCount = frame
      .locator('.shell-table')
      .filter({ hasText: /^auth_audit/ })
      .locator('.shell-table-rows');
    const before = Number(((await sidebarCount.textContent()) ?? '').trim());
    expect(Number.isNaN(before)).toBe(false);

    await frame.locator('.new-row-button').click();
    await expect(frame.locator('.row-dialog')).toBeVisible();

    // The label says what an empty field will do, which is not the same answer for every column.
    await expect(frame.locator('.row-dialog').getByText('пусто = по умолчанию').first()).toBeVisible();

    /*
     * The key is written here rather than generated by the button beside it, because the row is found
     * again further down by the value this check chose.
     */
    const keyField = frame.locator('.row-dialog .field').filter({ hasText: 'id' }).first().locator('input');
    await keyField.fill(id);
    await frame
      .locator('.row-dialog .field')
      .filter({ hasText: /^action/ })
      .first()
      .locator('input')
      .fill(action);
    await frame.locator('.row-dialog button').filter({ hasText: 'Добавить' }).click();

    /*
     * Newest first, so the row just added is the one to look at. One click is enough, and that is
     * itself a fact about this table: it opens sorted by `created_at` — the column that records the
     * order rows arrived in — so the menu's entry already reads «Сортировать по убыванию».
     */
    const head = frame.locator('.column-head').filter({ hasText: /^created_at/ }).first();
    await expect(head.locator('.column-sort')).toHaveText('↑');

    await head.click();
    await frame
      .locator('.el-dropdown-menu__item:visible')
      .filter({ hasText: 'Сортировать по убыванию' })
      .first()
      .click();
    await expect(head.locator('.column-sort')).toHaveText('↓', { timeout: 20_000 });

    const first = frame.locator('.el-table__row').first();
    await expect(first).toContainText(action, { timeout: 20_000 });

    // One row more, without another trip to the server.
    await expect(sidebarCount).toHaveText(String(before + 1));

    /*
     * What the database filled in, and the reason this table was chosen: `details` shows its default
     * `{}` rather than an empty value, and `created_at` a timestamp rather than nothing. The `null`s in
     * the row are the optional columns left empty, which is what empty means for them.
     */
    await expect(first).toContainText('{}');
    await expect(first).toContainText(/\d{4}-\d{2}-\d{2}T/);

    // Away again, confirming as a person would.
    await first.locator('.actions-delete').click();
    await frame.locator('.el-message-box__btns button').filter({ hasText: 'Удалить' }).click();
    await expect(frame.locator('.el-table__row').first()).not.toContainText(action, { timeout: 20_000 });

    // And back to the number it started at, which is what a person watching the sidebar expects.
    await expect(sidebarCount).toHaveText(String(before));

    expectNoPageErrors(problems);
  });

  test('shows a two-column key as the key of that table', async ({ page }) => {
    const frame = await openDatabaseSection(page);

    await chooseDatabase(page, frame, /_admin$/);
    await frame.locator('.shell-table-name').filter({ hasText: 'administrator_grants' }).click();

    // Nothing refuses here: the table opens, and its own key is what a row would be addressed by.
    await expect(frame.locator('.column-head').filter({ hasText: 'administrator_id' })).toBeVisible();
    await expect(frame.locator('.column-head').filter({ hasText: /^service\s/ })).toBeVisible();
  });

  /**
   * A key can be generated; a reference cannot, and is not offered.
   *
   * Nothing fills in a `uuid PRIMARY KEY` without a default, so the form offers to make one — and every
   * field starts empty, including that one. `administrators.user_id` is a uuid of the same shape but
   * points at a row in another module's database, where no foreign key would catch a made up value:
   * the row would be saved pointing at nothing. So the button belongs to the key alone.
   */
  test('offers to generate the key, and only the key', async ({ page }) => {
    const frame = await openDatabaseSection(page);

    await chooseDatabase(page, frame, /_admin$/);
    await frame.locator('.shell-table-name').filter({ hasText: /^administrators$/ }).click();
    await expect(frame.locator('.new-row-button')).toBeVisible({ timeout: 20_000 });

    await frame.locator('.new-row-button').click();
    await expect(frame.locator('.row-dialog')).toBeVisible();

    const field = (name: string) =>
      frame.locator('.row-dialog .field').filter({ hasText: name }).first();

    // Nothing is filled in for the person: the form opens empty, key included.
    await expect(field('id').locator('input')).toHaveValue('');
    await expect(field('user_id').locator('input')).toHaveValue('');

    await expect(field('user_id').locator('.field-generate')).toHaveCount(0);
    await field('id').locator('.field-generate').click();

    await expect(field('id').locator('input')).toHaveValue(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await expect(field('user_id').locator('input')).toHaveValue('');

    await frame.locator('.row-dialog button').filter({ hasText: 'Отмена' }).click();
    await expect(frame.locator('.row-dialog')).toBeHidden();
  });

  /**
   * Columns from the screen, and the line the screen must not cross.
   *
   * A column this interface added can be renamed and dropped; a column of a module's migration cannot,
   * because the module's code reads it by name. The server refuses either way — what is checked here is
   * that the menu does not offer what would be refused, and that the added column arrives with the type
   * it was asked for. The column is dropped again at the end, so the stand is left as it was found.
   */
  test('adds a column, offers it what a migration column is not offered, and drops it', async ({
    page,
  }) => {
    const problems = collectPageErrors(page);
    const frame = await openDatabaseSection(page);
    await refuseToWriteIntoTheRepository(page);

    await chooseDatabase(page, frame, /_admin$/);
    await frame.locator('.shell-table-name').filter({ hasText: /^administrators$/ }).click();
    await expect(frame.locator('.el-table__row').first()).toBeVisible({ timeout: 20_000 });

    const column = `probe_${Date.now()}`;
    await frame.locator('.add-column-button').click();
    await frame.locator('.add-column-name input').fill(column);
    await frame.locator('.add-column-submit').click();

    // It arrives in the table, with the type it was given.
    const head = frame.locator('.column-head').filter({ hasText: new RegExp(`^${column}`) }).first();
    await expect(head).toBeVisible({ timeout: 20_000 });
    await expect(head).toContainText('text');

    // Its own column may be renamed and dropped; a migration's column may not.
    await head.scrollIntoViewIfNeeded();
    await head.click();
    await expect(
      frame.locator('.el-dropdown-menu__item:visible').filter({ hasText: 'Удалить колонку' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');

    await frame.locator('.column-head').filter({ hasText: /^email/ }).first().click();
    await expect(
      frame.locator('.el-dropdown-menu__item:visible').filter({ hasText: 'Переименовать колонку' }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');

    // And back to how the table was: drop it, confirming as a person would.
    await head.scrollIntoViewIfNeeded();
    await head.click();
    await frame
      .locator('.el-dropdown-menu__item:visible')
      .filter({ hasText: 'Удалить колонку' })
      .click();
    await frame.locator('.el-message-box__btns button').filter({ hasText: 'Удалить' }).click();

    await expect(
      frame.locator('.column-head').filter({ hasText: new RegExp(`^${column}`) }),
    ).toHaveCount(0, { timeout: 20_000 });

    expectNoPageErrors(problems);
  });

  /**
   * A required column, and the default that comes with it.
   *
   * `NOT NULL` alone would break the module — its `INSERT` names the columns it knows, and would have
   * nothing to put in one it has never heard of. A default makes it safe, so the dialog offers the two
   * together: switch the column to required and the field fills in with the neutral value of its type.
   */
  test('offers a default as soon as a new column is made required', async ({ page }) => {
    const problems = collectPageErrors(page);
    const frame = await openDatabaseSection(page);
    await refuseToWriteIntoTheRepository(page);

    await chooseDatabase(page, frame, /_admin$/);
    await frame.locator('.shell-table-name').filter({ hasText: /^administrators$/ }).click();
    await expect(frame.locator('.el-table__row').first()).toBeVisible({ timeout: 20_000 });

    const column = `probe_${Date.now()}`;
    await frame.locator('.add-column-button').click();
    await frame.locator('.add-column-name input').fill(column);

    // A number, made required: the field fills in with zero and the note says the rows will get it.
    await frame.locator('.add-column-type').click();
    await frame.locator('.el-select-dropdown__item:visible').filter({ hasText: 'целое число' }).first().click();
    await frame.locator('.add-column-required').click();

    await expect(frame.locator('.add-column-default input')).toHaveValue('0');
    await expect(frame.locator('.add-column-note')).toContainText('останется у неё навсегда');

    await frame.locator('.add-column-submit').click();

    // It arrives required, which the row dialog shows by not offering "пусто = null" for it.
    const head = frame.locator('.column-head').filter({ hasText: new RegExp(`^${column}`) }).first();
    await expect(head).toBeVisible({ timeout: 20_000 });

    // And away again, so the stand is left as it was found.
    await head.scrollIntoViewIfNeeded();
    await head.click();
    await frame
      .locator('.el-dropdown-menu__item:visible')
      .filter({ hasText: 'Удалить колонку' })
      .click();
    await frame.locator('.el-message-box__btns button').filter({ hasText: 'Удалить' }).click();
    await expect(head).toHaveCount(0, { timeout: 20_000 });

    expectNoPageErrors(problems);
  });

  /** The two tables that record what has been applied are not reshapable, and the screen knows it. */
  /**
   * A date is picked, not typed — in both dialogs.
   *
   * Writing `2026-09-15T12:00:00+03:00` by hand is what this replaces. The switch beside the calendar
   * is for the one value a calendar cannot express: `now`, which reaches the database as `now()` rather
   * than as the moment somebody opened the dialog.
   */
  test('offers a calendar for a date instead of a field to type in', async ({ page }) => {
    const problems = collectPageErrors(page);
    const frame = await openDatabaseSection(page);
    await refuseToWriteIntoTheRepository(page);

    await chooseDatabase(page, frame, /_auth$/);
    await frame.locator('.shell-table-name').filter({ hasText: /^auth_audit$/ }).click();
    await expect(frame.locator('.el-table__row').first()).toBeVisible({ timeout: 20_000 });

    // A new row: the timestamp column gets a calendar.
    await frame.locator('.new-row-button').click();
    await expect(frame.locator('.row-dialog')).toBeVisible();
    await expect(
      frame.locator('.row-dialog .field').filter({ hasText: /^created_at/ }).locator('.field-date'),
    ).toBeVisible();
    await frame.locator('.row-dialog button').filter({ hasText: 'Отмена' }).click();

    // A new column of type date: a calendar as well, and the switch that means "now" instead.
    await frame.locator('.add-column-button').click();
    await frame.locator('.add-column-type').click();

    // Every type carries what it holds in plain words: the names alone read only to whoever knows them.
    await expect(
      frame.locator('.el-select-dropdown__item:visible').filter({ hasText: 'timestamptz' }),
    ).toContainText('дата и время');

    await frame
      .locator('.el-select-dropdown__item:visible')
      .filter({ hasText: 'только дата' })
      .click();

    await expect(frame.locator('.add-column-date')).toBeVisible();
    await expect(frame.locator('.add-column-now')).toContainText('Текущая дата');

    await frame.locator('.add-column-now-switch').click();
    await expect(frame.locator('.add-column-date')).toHaveCount(0);

    expectNoPageErrors(problems);
  });

  test('offers no new column on the tables that record migrations', async ({ page }) => {
    const frame = await openDatabaseSection(page);

    await chooseDatabase(page, frame, /_admin$/);
    await frame.locator('.shell-table-name').filter({ hasText: /^schema_migrations$/ }).click();
    await expect(frame.locator('.column-head').first()).toBeVisible({ timeout: 20_000 });

    await expect(frame.locator('.add-column-button')).toHaveCount(0);
  });

  /**
   * The theme is the one contract this screen keeps with the panel, and it is not a React component:
   * the panel sends a message, the screen writes the attribute. Nothing else connects the two.
   */
  test('follows the theme the panel sends it', async ({ page }) => {
    const frame = await openDatabaseSection(page);
    const html = frame.locator('html');

    await page.evaluate(() => {
      const embedded = document.querySelector('iframe');
      embedded?.contentWindow?.postMessage(
        { type: 'template.admin.theme', theme: 'dark' },
        window.location.origin,
      );
    });
    await expect(html).toHaveAttribute('data-theme', 'dark');

    await page.evaluate(() => {
      const embedded = document.querySelector('iframe');
      embedded?.contentWindow?.postMessage(
        { type: 'template.admin.theme', theme: 'light' },
        window.location.origin,
      );
    });
    await expect(html).toHaveAttribute('data-theme', 'light');
  });
});
