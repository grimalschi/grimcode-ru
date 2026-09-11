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
