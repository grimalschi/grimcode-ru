import { expect, test } from '@playwright/test';

import { collectPageErrors, expectNoPageErrors, signIn } from './support.js';

/**
 * The Email admin, which is the heaviest surface in the template.
 *
 * It carries a self-hosted editor, so this is where a bundle is most likely to throw on load, and
 * where a message rendered from the delivery log has to be kept from acting on the panel.
 */

test.describe('the email admin', () => {
  test('lists the seeded templates without a runtime error', async ({ page }) => {
    const problems = collectPageErrors(page);

    await signIn(page);
    await page.goto('/admin/service/email/');

    await expect(page.getByRole('heading', { name: 'Шаблоны' })).toBeVisible();
    await expect(page.getByText('auth-password-reset')).toBeVisible();

    expectNoPageErrors(problems);
  });

  test('opens the editor, which loads only on its own route', async ({ page }) => {
    const problems = collectPageErrors(page);

    await signIn(page);
    await page.goto('/admin/service/email/');

    await page.getByRole('link', { name: /Восстановление пароля/ }).click();
    await expect(page.getByRole('heading', { name: /Восстановление пароля/ })).toBeVisible();

    // A published version opens read-only; that is the record of what was approved.
    // Whatever language the seed is in — the point is that a version opens, not which locale.
    await page.getByRole('link', { name: /· v1/ }).first().click();

    await expect(page.getByLabel('Тема')).toBeVisible();
    // The editor's own surface, meaning the lazily loaded chunk arrived and ran.
    await expect(page.locator('.tiptap, [contenteditable]').first()).toBeVisible();

    expectNoPageErrors(problems);
  });

  test('shows a delivery in full, and previews it without giving it any power', async ({ page }) => {
    const problems = collectPageErrors(page);

    await signIn(page);
    await page.goto('/admin/service/email/deliveries');

    await expect(page.getByRole('heading', { name: 'Отправки' })).toBeVisible();

    const firstRow = page.locator('tbody tr').first();
    await expect(firstRow).toBeVisible();
    await firstRow.click();

    // The stored snapshot, both as a rendered message and as its source.
    const preview = page.frameLocator('iframe[title="Предпросмотр письма"]');
    await expect(preview.locator('body')).toBeVisible();

    /*
     * The preview frame is fully sandboxed: no scripts, and no access to this origin. A stored
     * message is content someone else's flow produced, so it is shown, never trusted. Checked while
     * the tab is open, because the other tabs unmount it.
     */
    const sandbox = await page.locator('iframe[title="Предпросмотр письма"]').getAttribute('sandbox');
    expect(sandbox).toBe('');

    await page.getByRole('tab', { name: 'HTML' }).click();
    await expect(page.getByText('<!DOCTYPE', { exact: false })).toBeVisible();

    await page.getByRole('tab', { name: 'Текст' }).click();
    await expect(page.locator('pre').first()).toBeVisible();

    expectNoPageErrors(problems);
  });
});
