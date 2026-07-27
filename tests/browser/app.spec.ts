import { expect, test } from '@playwright/test';

import { collectPageErrors, expectNoPageErrors, OWNER_EMAIL, OWNER_PASSWORD, signIn } from './support.js';

/**
 * The application's guard, in the browser where it actually runs.
 *
 * The server refuses every protected call regardless, so what is checked here is the other half:
 * that a person who is not signed in never sees the protected interface, and that being sent to
 * sign in returns them to where they were going — but only if that was a page of this application.
 */

test.describe('an anonymous visitor', () => {
  test('is sent to sign in instead of the dashboard', async ({ page }) => {
    const problems = collectPageErrors(page);

    await page.goto('/app/');
    await page.waitForURL(/\/app\/login/);

    // The card's title is a styled element rather than a heading, so this asserts on what a person
    // actually reads.
    await expect(page.getByText('Вход', { exact: true }).first()).toBeVisible();
    await expect(page.getByLabel('Пароль')).toBeVisible();

    expectNoPageErrors(problems);
  });

  test('never sees the protected interface, not even for a moment', async ({ page }) => {
    await page.goto('/app/settings');
    await page.waitForURL(/\/app\/login/);

    // None of the settings sections ever rendered.
    await expect(page.getByRole('tab', { name: 'Безопасность' })).toHaveCount(0);
    await expect(page.getByText(OWNER_EMAIL)).toHaveCount(0);
  });

  test('is offered a way back to the page they wanted', async ({ page }) => {
    await page.goto('/app/settings');
    await page.waitForURL(/\/app\/login/);

    const next = new URL(page.url()).searchParams.get('next');
    expect(next).toBe('/app/settings');
  });

  /**
   * The return path is the sort of parameter that turns a sign-in page into someone else's
   * redirect, so anything but an internal application route is dropped.
   */
  test('cannot be sent somewhere else by the return path', async ({ page, baseURL }) => {
    for (const attempt of ['https://example.com/', '//example.com/', '/admin/', '/app/login']) {
      await page.goto(`/app/login?next=${encodeURIComponent(attempt)}`);

      await page.getByLabel('Почта').fill(OWNER_EMAIL);
      await page.getByLabel('Пароль').fill(OWNER_PASSWORD);
      await page.getByRole('button', { name: 'Войти' }).click();

      await page.waitForURL((url) => !url.pathname.startsWith('/app/login'));

      // Landed inside this application, on this origin — never on the one the parameter named.
      const landed = new URL(page.url());
      expect(landed.origin).toBe(new URL(baseURL!).origin);
      expect(landed.pathname).toMatch(/^\/app\//);
      expect(landed.pathname).not.toMatch(/^\/app\/login/);

      await page.goto('/app/settings');
      await page.getByRole('button', { name: 'Выйти' }).click();
      await page.waitForURL(/\/app\/login/);
    }
  });
});

test.describe('a signed-in person', () => {
  test('reaches the application and its settings', async ({ page }) => {
    const problems = collectPageErrors(page);

    await signIn(page);
    await page.goto('/app/settings');

    await expect(page.getByRole('tab', { name: 'Профиль' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Аккаунт' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Безопасность' })).toBeVisible();

    // One settings screen with sections, not three separate destinations.
    await expect(page.getByRole('link', { name: 'Профиль' })).toHaveCount(0);

    expectNoPageErrors(problems);
  });

  test('returns to the page they were sent away from', async ({ page }) => {
    await page.goto('/app/settings');
    await page.waitForURL(/\/app\/login/);

    await page.getByLabel('Почта').fill(OWNER_EMAIL);
    await page.getByLabel('Пароль').fill(OWNER_PASSWORD);
    await page.getByRole('button', { name: 'Войти' }).click();

    await page.waitForURL(/\/app\/settings/);
    await expect(page.getByRole('tab', { name: 'Безопасность' })).toBeVisible();
  });

  test('is put back out when the session ends', async ({ page }) => {
    await signIn(page);
    await page.goto('/app/settings');
    await expect(page.getByRole('tab', { name: 'Безопасность' })).toBeVisible();

    await page.getByRole('button', { name: 'Выйти' }).click();
    await page.waitForURL(/\/app\/login/);

    // And going back does not bring the interface back with it.
    await page.goto('/app/settings');
    await page.waitForURL(/\/app\/login/);
    await expect(page.getByRole('tab', { name: 'Безопасность' })).toHaveCount(0);
  });
});

/**
 * The link in the recovery email used to point at the form that asks for a link, so the flow could
 * not be completed at all — and the acceptance test of the day matched the broken address.
 */
test.describe('the recovery link', () => {
  test('opens the screen that sets a new password', async ({ page }) => {
    await page.goto('/app/reset-password/confirm?token=' + 'x'.repeat(40));

    await expect(page.getByLabel('Новый пароль')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Изменить пароль' })).toBeVisible();
  });

  test('says so when the link carries no token, instead of pretending', async ({ page }) => {
    await page.goto('/app/reset-password/confirm');

    await expect(page.getByText('Ссылка неполная')).toBeVisible();
    await expect(page.getByLabel('Новый пароль')).toHaveCount(0);
  });
});

test.describe('the public site', () => {
  test('renders and links into the application', async ({ page }) => {
    const problems = collectPageErrors(page);

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await page.getByRole('link', { name: 'Войти' }).click();
    await page.waitForURL(/\/app\//);

    expectNoPageErrors(problems);
  });

  test('answers an unknown address with its own not-found page', async ({ page }) => {
    const response = await page.goto('/no-such-page');

    expect(response?.status()).toBe(404);
    await expect(page.getByText('Такой страницы нет')).toBeVisible();
  });
});
