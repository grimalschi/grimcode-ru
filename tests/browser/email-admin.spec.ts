import { expect, test } from '@playwright/test';

import { moduleAdmin, type Session } from '../src/client.js';
import { ensureFixtureTemplate, resolveOwner, testEmail } from '../src/fixtures.js';

import { collectPageErrors, expectNoPageErrors, signIn } from './support.js';

function mjml(body: string) {
  return `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text></mj-column></mj-section></mj-body></mjml>`;
}

async function createEditorDraft(owner: Session, subject: string, source: string) {
  const prefix = moduleAdmin('email');
  const templateId = await ensureFixtureTemplate(owner, 'browser-editor', []);
  const { version } = await owner.call<{ version: { id: string } }>(
    prefix, 'createDraft', { templateId }, { csrf: true },
  );
  await owner.call(prefix, 'saveDraft', {
    id: version.id, subject, source,
  }, { csrf: true });
  return version.id;
}

test.describe('the email admin', () => {
  test('lists the seeded templates without a runtime error', async ({ page }) => {
    const problems = collectPageErrors(page);

    await signIn(page);
    await page.goto('/admin/embed/module/email/');

    await expect(page.getByRole('heading', { name: 'Шаблоны' })).toBeVisible();
    await expect(page.getByText('auth-password-reset')).toBeVisible();

    expectNoPageErrors(problems);
  });

  test('opens a template, and then a version, from anywhere on its row', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/embed/module/email/');
    // Not the name: a cell elsewhere on the row.
    await page.getByRole('row').filter({ hasText: 'auth-password-reset' }).getByRole('cell').nth(1).click();
    await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/);
    await page.getByRole('row').filter({ hasText: 'Версия 1' }).getByRole('cell').nth(1).click();
    await expect(page).toHaveURL(/\/versions\/[0-9a-f-]{36}$/);
    // A published version shows its plain-text alternative in a tab of its own.
    await page.getByRole('tab', { name: 'Текст', exact: true }).click();
    await expect(page.getByRole('tabpanel')).toContainText('Восстановление пароля');
  });

  test('opens a template whole, with a loader only while its answer is late', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/embed/module/email/');
    await expect(page.getByRole('row').filter({ hasText: 'auth-password-reset' })).toBeVisible();

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/rpc/getTemplate*', async (route) => { await held; await route.continue(); });
    await page.getByRole('row').filter({ hasText: 'auth-password-reset' }).click();

    // No half-made page in between: no stand-in title, no placeholder rows — a loader once it is late.
    await expect(page.getByRole('status')).toHaveText('Загружаем…');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(0);
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
    release();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Восстановление пароля');
    await expect(page.getByRole('status')).toHaveCount(0);
  });

  test('names statuses in Russian and explains the variables', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/embed/module/email/');
    await page.getByRole('row').filter({ hasText: 'auth-password-reset' }).click();
    await expect(page.getByText('Опубликована', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('published', { exact: true })).toHaveCount(0);
    await expect(page.getByText('{{resetUrl}}', { exact: true })).toBeVisible();
    await expect(page.getByText('ссылка для сброса пароля', { exact: true })).toBeVisible();

    await page.goto('/admin/embed/module/email/deliveries');
    // The suite runs with the local transport: a letter it took is «Сохранено», not «Отправлено» beside «без отправки».
    const letter = page.getByRole('row').filter({ hasText: 'локально, без отправки' }).first();
    await expect(letter).toContainText('Сохранено');
    await expect(letter).not.toContainText('Отправлено');
    await page.getByRole('combobox').filter({ hasText: 'Любой статус' }).click();
    await expect(page.getByRole('option')).toHaveText(['Любой статус', 'В очереди', 'Отправлено', 'Ошибка']);
  });

  test('opens published source for reading and copying', async ({ page }) => {
    const problems = collectPageErrors(page);

    await signIn(page);
    await page.goto('/admin/embed/module/email/');

    await page.getByRole('link', { name: /Восстановление пароля/ }).click();
    await expect(page.getByRole('heading', { name: /Восстановление пароля/ })).toBeVisible();

    await page.getByRole('link', { name: /Версия 1/ }).first().click();

    await expect(page.getByLabel('Тема', { exact: true })).not.toBeEditable();
    await expect(page.getByLabel('Код MJML')).toHaveAttribute('readonly', '');
    await expect(page.getByLabel('Код MJML')).toHaveValue(/<mjml>/);
    await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toHaveCount(0);

    expectNoPageErrors(problems);
  });

  test('shows the stored HTML and text with a sandboxed delivery preview', async ({ page }) => {
    const problems = collectPageErrors(page);
    const owner = await resolveOwner();
    const id = await createEditorDraft(owner, 'Browser delivery',
      mjml('<p>Stored HTML body</p><script>parent.document.body.dataset.emailPreviewRan = "yes";</script>'));
    const to = testEmail('browser-delivery');
    await owner.call(moduleAdmin('email'), 'testSend', { id, to }, { csrf: true });

    await signIn(page);
    await page.goto('/admin/embed/module/email/deliveries');

    await expect(page.getByRole('heading', { name: 'Отправки' })).toBeVisible();

    await page.getByPlaceholder('Поиск по получателю или теме').fill(to);
    await page.getByRole('row').filter({ hasText: to }).first().click();

    const preview = page.frameLocator('iframe[title="Предпросмотр письма"]');
    await expect(preview.locator('body')).toContainText('Stored HTML body');
    await expect(preview.locator('script')).toHaveCount(0);
    await expect(page.locator('body')).not.toHaveAttribute('data-email-preview-ran', 'yes');
    await expect(page.locator('iframe[title="Предпросмотр письма"]')).toHaveAttribute('sandbox', '');

    await page.getByRole('tab', { name: 'HTML' }).click();
    await expect(page.getByRole('dialog').locator('pre')).toContainText('<p>Stored HTML body</p>');

    await page.getByRole('tab', { name: 'Текст' }).click();
    await expect(page.getByRole('dialog').locator('pre')).toHaveText('Stored HTML body');

    expectNoPageErrors(problems);
  });
  test('switches versions from the corner, asking before unsaved edits are dropped', async ({ page }) => {
    const owner = await resolveOwner();
    const first = await createEditorDraft(owner, 'Switch A', mjml('<p>Switch A</p>'));
    const second = await createEditorDraft(owner, 'Switch B', mjml('<p>Switch B</p>'));
    const numbers = await Promise.all([first, second].map(async (id) =>
      (await owner.call<{ version: { version: number } }>(moduleAdmin('email'), 'getVersion', { id })).version.version));
    await signIn(page);
    await page.goto(`/admin/embed/module/email/versions/${first}`);
    await expect(page.getByLabel('Тема', { exact: true })).toHaveValue('Switch A');

    const pick = async () => {
      await page.getByRole('combobox', { name: 'Версия' }).click();
      await page.getByRole('option', { name: `Версия ${numbers[1]} · Черновик` }).click();
    };
    await page.getByLabel('Тема', { exact: true }).fill('Switch A, unsaved');
    await pick();
    await page.getByRole('button', { name: 'Остаться' }).click();
    await expect(page.getByLabel('Тема', { exact: true })).toHaveValue('Switch A, unsaved');

    // Hold the next version back: the page stays — title, switcher, the old text dimmed — instead of blanking.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/rpc/getVersion*', async (route) => { await held; await route.continue(); });
    const title = await page.getByRole('heading', { level: 1 }).textContent();
    await pick();
    await page.getByRole('button', { name: 'Перейти', exact: true }).click();
    await expect(page.locator('[aria-busy="true"]')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title ?? '');
    await expect(page.getByRole('combobox', { name: 'Версия' })).toBeVisible();
    release();
    await expect(page).toHaveURL(new RegExp(`/versions/${second}$`));
    await expect(page.getByLabel('Тема', { exact: true })).toHaveValue('Switch B');
  });

  test('shows a draft\'s plain text, unsaved edits included', async ({ page }) => {
    const owner = await resolveOwner();
    const id = await createEditorDraft(owner, 'Text subject', mjml('<p>Saved words</p>'));
    await signIn(page);
    await page.goto(`/admin/embed/module/email/versions/${id}`);
    await page.getByLabel('Код MJML').fill(mjml('<p>Unsaved words</p>'));
    await page.getByRole('tab', { name: 'Текст', exact: true }).click();
    await expect(page.getByRole('tabpanel')).toContainText('Unsaved words');
  });

  test('switching versions keeps unsaved content out of the other draft', async ({ page }) => {
    const problems = collectPageErrors(page);
    const owner = await resolveOwner();
    const first = await createEditorDraft(owner, 'Subject A', mjml('<p>Body A</p>'));
    const second = await createEditorDraft(owner, 'Subject B', mjml('<p>Body B</p>'));
    await signIn(page);
    await page.goto(`/admin/module/email#/versions/${first}`);
    const editor = page.frameLocator('iframe');
    await expect(editor.getByLabel('Тема', { exact: true })).toHaveValue('Subject A');
    await editor.getByLabel('Тема', { exact: true }).fill('Unsaved A');
    await editor.getByLabel('Код MJML').fill(mjml('<p>Unsaved body A</p>'));

    await page.evaluate((id) => { window.location.hash = `/versions/${id}`; }, second);
    await expect(editor.getByLabel('Тема', { exact: true })).toHaveValue('Subject B');
    await expect(editor.getByLabel('Код MJML')).toHaveValue(mjml('<p>Body B</p>'));
    const saved = page.waitForResponse('**/email/rpc/saveDraft');
    await editor.getByRole('button', { name: 'Сохранить', exact: true }).click();
    expect((await saved).ok()).toBe(true);

    const { version } = await owner.call<{ version: { subject: string; source: string } }>(
      moduleAdmin('email'), 'getVersion', { id: second },
    );
    expect(version.subject).toBe('Subject B');
    expect(version.source).toBe(mjml('<p>Body B</p>'));
    expectNoPageErrors(problems);
  });

  test('preview uses the current draft and switching back preserves unsaved text', async ({ page }) => {
    const problems = collectPageErrors(page);
    const owner = await resolveOwner();
    const id = await createEditorDraft(owner, 'Saved subject', mjml('<p>Saved body</p>'));
    await signIn(page);
    await page.goto(`/admin/embed/module/email/versions/${id}`);
    await expect(page.getByLabel('Тема', { exact: true })).toHaveValue('Saved subject');
    await page.getByLabel('Тема', { exact: true }).fill('Unsaved subject');
    await page.getByLabel('Код MJML').fill(mjml('<p>Unsaved body</p>'));
    await page.getByRole('tab', { name: 'Предпросмотр', exact: true }).click();
    await expect(page.getByText('Unsaved subject', { exact: true })).toBeVisible();
    await expect(page.frameLocator('iframe[title="Предпросмотр письма"]').locator('body')).toContainText('Unsaved body');
    await expect(page.locator('iframe[title="Предпросмотр письма"]')).toHaveAttribute('sandbox', '');

    const savedBeforePreview = await owner.call<{ version: { subject: string; source: string } }>(
      moduleAdmin('email'), 'getVersion', { id },
    );
    expect(savedBeforePreview.version).toMatchObject({ subject: 'Saved subject', source: mjml('<p>Saved body</p>') });

    await page.getByRole('tab', { name: 'MJML', exact: true }).click();
    await expect(page.getByLabel('Код MJML')).toHaveValue(mjml('<p>Unsaved body</p>'));
    const saved = page.waitForResponse('**/email/rpc/saveDraft');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    expect((await saved).ok()).toBe(true);
    const { version } = await owner.call<{ version: { subject: string; source: string } }>(
      moduleAdmin('email'), 'getVersion', { id },
    );
    expect(version.subject).toBe('Unsaved subject');
    expect(version.source).toBe(mjml('<p>Unsaved body</p>'));
    expectNoPageErrors(problems);
  });

  test('test send compiles the current MJML source with the current subject', async ({ page }) => {
    const problems = collectPageErrors(page);
    const owner = await resolveOwner();
    const id = await createEditorDraft(owner, 'Saved subject', mjml('<p>Saved body</p>'));
    await signIn(page);
    await page.goto(`/admin/embed/module/email/versions/${id}`);
    await expect(page.getByLabel('Тема', { exact: true })).toHaveValue('Saved subject');
    await page.getByLabel('Тема', { exact: true }).fill('Test subject');
    await page.getByLabel('Код MJML').fill(mjml('<p>Test body</p>'));
    await page.getByRole('button', { name: 'Тестовая отправка', exact: true }).click();
    const to = testEmail('browser-test-send');
    await page.getByLabel('Кому', { exact: true }).fill(to);
    const sent = page.waitForResponse('**/email/rpc/testSend');
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    const response = await sent;
    expect(response.ok()).toBe(true);
    const body = await response.json() as { result: { data: { deliveryId: string } } };
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const { delivery } = await owner.call<{ delivery: { recipientEmail: string; subject: string; html: string; status: string } }>(
      moduleAdmin('email'), 'getDelivery', { id: body.result.data.deliveryId },
    );
    expect(delivery).toMatchObject({ recipientEmail: to, subject: 'Test subject', status: 'sent' });
    expect(delivery.html).toContain('<p>Test body</p>');
    expectNoPageErrors(problems);
  });

  test('publishes the current MJML source as HTML', async ({ page }) => {
    const problems = collectPageErrors(page);
    const owner = await resolveOwner();
    const id = await createEditorDraft(owner, 'Saved subject', mjml('<p>Saved HTML</p>'));
    const source = '<mjml><mj-body><mj-section><mj-column><mj-text>Published MJML</mj-text></mj-column></mj-section></mj-body></mjml>';
    await signIn(page);
    await page.goto(`/admin/embed/module/email/versions/${id}`);
    await expect(page.getByLabel('Тема', { exact: true })).toHaveValue('Saved subject');
    await page.getByLabel('Тема', { exact: true }).fill('Published subject');
    await page.getByLabel('Код MJML').fill(source);
    await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
    await expect(page.getByLabel('Код MJML')).toHaveAttribute('readonly', '');
    const { version } = await owner.call<{ version: { status: string; subject: string; source: string; compiledHtml: string } }>(
      moduleAdmin('email'), 'getVersion', { id },
    );
    expect(version).toMatchObject({ status: 'published', subject: 'Published subject', source });
    expect(version.compiledHtml).toContain('Published MJML');
    expect(version.compiledHtml).not.toContain('<mj-text>');
    expectNoPageErrors(problems);
  });

  test('the journal shows who saved and published a version', async ({ page }) => {
    const problems = collectPageErrors(page);
    const owner = await resolveOwner();
    const id = await createEditorDraft(owner, 'Journal subject', mjml('<p>Journal body</p>'));
    const { version } = await owner.call<{ version: { version: number } }>(moduleAdmin('email'), 'getVersion', { id });
    await signIn(page);
    await page.goto(`/admin/embed/module/email/versions/${id}`);
    await expect(page.getByLabel('Тема', { exact: true })).toHaveValue('Journal subject');
    await page.getByLabel('Тема', { exact: true }).fill('Journal subject, edited');
    await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
    await expect(page.getByLabel('Код MJML')).toHaveAttribute('readonly', '');

    await page.getByRole('link', { name: 'История шаблонов', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'История шаблонов' })).toBeVisible();
    // Details are not raw JSON in the table any more; a click on the row opens them by name in a window.
    await expect(page.getByText('"templateKey"')).toHaveCount(0);
    const ownerEmail = process.env.ACCEPTANCE_OWNER_EMAIL?.toLowerCase() ?? '';
    const thisVersion = new RegExp(`Версия\\s*${version.version}(\\D|$)`);
    // Other tests write here at the same time, so the entry for this version is looked for among the rows.
    const entriesOf = async (action: string) => {
      const rows = page.getByRole('row').filter({ hasText: action });
      let found = 0;
      for (let index = 0; index < await rows.count(); index += 1) {
        await rows.nth(index).click();
        const card = page.getByRole('dialog');
        const text = await card.innerText();
        if (text.includes('browser-editor') && thisVersion.test(text)) {
          found += 1;
          expect(text, action).toContain(ownerEmail);
        }
        await card.getByRole('button', { name: 'Закрыть' }).click();
        await expect(card).toHaveCount(0);
      }
      return found;
    };
    expect(await entriesOf('version.published')).toBe(1);
    expect(await entriesOf('version.draft.saved')).toBe(2);
    expectNoPageErrors(problems);
  });

  test('invalid MJML shows a preview error and keeps the source editable', async ({ page }) => {
    const owner = await resolveOwner();
    const id = await createEditorDraft(owner, 'Invalid MJML', mjml('<p>Saved body</p>'));
    const source = '<mjml><mj-body><mj-unknown>Invalid component</mj-unknown></mj-body></mjml>';
    await signIn(page);
    await page.goto(`/admin/embed/module/email/versions/${id}`);
    await expect(page.getByLabel('Тема', { exact: true })).toHaveValue('Invalid MJML');
    await page.getByLabel('Код MJML').fill(source);
    await page.getByRole('tab', { name: 'Предпросмотр', exact: true }).click();
    await expect(page.getByText(/mj-unknown/)).toBeVisible();
    await expect(page.locator('iframe[title="Предпросмотр письма"]')).toHaveCount(0);
    await page.getByRole('tab', { name: 'MJML', exact: true }).click();
    await expect(page.getByLabel('Код MJML')).toHaveValue(source);
    await expect(page.getByLabel('Код MJML')).toBeEditable();
  });
});
