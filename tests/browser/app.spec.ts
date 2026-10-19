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

    // Only the page that is open is marked in the header, and the home page is not lit everywhere.
    const navigation = page.getByRole('navigation');
    await expect(navigation.getByRole('link', { name: 'Настройки' })).toHaveAttribute('data-status', 'active');
    await expect(navigation.getByRole('link', { name: 'Главная' })).not.toHaveAttribute('data-status', 'active');
    // At rest the other item is grey; under the pointer it turns the colour of the open one.
    const color = (name: string) => navigation.getByRole('link', { name }).evaluate((element) => getComputedStyle(element).color);
    const open = await color('Настройки');
    expect(await color('Главная')).not.toBe(open);
    await navigation.getByRole('link', { name: 'Главная' }).hover();
    await expect.poll(() => color('Главная')).toBe(open);
    // The buttons beside it answer the pointer the same way.
    const signOut = page.getByRole('button', { name: 'Выйти' });
    const signOutColor = () => signOut.evaluate((element) => getComputedStyle(element).color);
    expect(await signOutColor()).not.toBe(open);
    await signOut.hover();
    await expect.poll(signOutColor).toBe(open);
    await navigation.getByRole('link', { name: 'Главная' }).click();
    await expect(navigation.getByRole('link', { name: 'Главная' })).toHaveAttribute('data-status', 'active');
    await expect(navigation.getByRole('link', { name: 'Настройки' })).not.toHaveAttribute('data-status', 'active');

    expectNoPageErrors(problems);
  });

  test('confirms an address change with the password, and keeps the address when the password is wrong', async ({ page, request }) => {
    const problems = collectPageErrors(page);

    await signIn(page);
    await page.goto('/app/settings');
    await page.getByRole('tab', { name: 'Аккаунт' }).click();

    // The form stays folded until asked for, and the card needs no button to refresh it.
    await expect(page.getByLabel('Новый адрес')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Обновить' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Сменить адрес' }).click();

    const address = page.getByLabel('Новый адрес');
    const password = page.getByLabel('Подтвердите пароль');
    const send = page.getByRole('button', { name: 'Отправить', exact: true });
    // A password manager is told which account the password belongs to, not offered the new address.
    await expect(page.locator('input[autocomplete="username"]')).toHaveValue(OWNER_EMAIL);
    await expect(address).toHaveAttribute('autocomplete', 'email');
    await expect(password).toHaveAttribute('autocomplete', 'current-password');

    await address.fill('someone-new@example.test');
    await expect(send).toBeDisabled();
    await password.fill(`${OWNER_PASSWORD}-wrong`);
    await send.click();
    await expect(page.getByText('Текущий пароль неверен')).toBeVisible();
    // The address stays for a second try; the password does not stay in the form.
    await expect(address).toHaveValue('someone-new@example.test');
    await expect(password).toHaveValue('');

    // A taken address is said to be taken, as on registration; the form stays as it was.
    const taken = `taken-${Date.now()}@example.test`;
    // Registered from a context of its own, so this page stays signed in as the owner.
    expect((await request.post('/module/auth/rpc/register', { data: { email: taken, password: 'Taken-address-pass-1' } })).ok()).toBe(true);
    await address.fill(taken);
    await password.fill(OWNER_PASSWORD);
    await send.click();
    await expect(page.getByText('Этот адрес уже занят')).toBeVisible();
    await expect(address).toHaveValue(taken);
    // The password was right, so it stays: only the address needs fixing.
    await expect(password).toHaveValue(OWNER_PASSWORD);

    await page.getByRole('button', { name: 'Отмена' }).click();
    await expect(address).toHaveCount(0);

    // The refusal of the wrong password is the one failed request the browser reports; anything else is a fault.
    expectNoPageErrors(problems.filter((problem) => !/status of (401|409)/.test(problem)));
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

  test('ends one other sign-in from the list, and keeps this browser in', async ({ page, browser, baseURL }) => {
    const problems = collectPageErrors(page);
    await signIn(page);

    // A second browser of the same person; its own list says which session it is.
    const elsewhere = await browser.newContext({ baseURL });
    const other = await elsewhere.newPage();
    await signIn(other);
    const listed = await other.request.post('/module/auth/rpc/listOwnSessions', { data: {} });
    const { sessions } = (await listed.json() as { result: { data: { sessions: { id: string; current: boolean }[] } } }).result.data;
    const otherId = sessions.find((session) => session.current)!.id;

    await page.goto('/app/settings');
    await page.getByRole('tab', { name: 'Безопасность' }).click();
    const current = page.getByTestId('own-session').filter({ hasText: 'Этот браузер' });
    await expect(current.getByRole('button', { name: 'Завершить' })).toHaveCount(0);
    // The device is named for a person, not by its raw user-agent string.
    await expect(current).toContainText(/Chrome, (Windows|Linux|macOS)/);
    await expect(current).not.toContainText('Mozilla/5.0');
    // The raw string is one hover away, on a name that shows it can be pointed at.
    const name = current.locator('[data-slot="tooltip-trigger"]');
    await expect.poll(() => name.evaluate((element) => getComputedStyle(element).cursor)).toBe('pointer');
    await name.hover();
    await expect(page.getByRole('tooltip')).toContainText('Mozilla/5.0');
    const row = page.locator(`[data-session-id="${otherId}"]`);
    await row.getByRole('button', { name: 'Завершить', exact: true }).click();
    await expect(row).toHaveCount(0);

    // That browser is out; this one is not.
    await other.goto('/app/settings');
    await other.waitForURL(/\/app\/login/);
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Безопасность' })).toBeVisible();
    await elsewhere.close();

    expectNoPageErrors(problems);
  });

  test('re-reads the account on coming back to the tab, so a confirmation made elsewhere shows', async ({ page }) => {
    await signIn(page);
    await page.goto('/app/settings');
    await page.getByRole('tab', { name: 'Аккаунт' }).click();
    await expect(page.getByText('Адрес, с которым вы входите.')).toBeVisible();

    const reread = page.waitForRequest('**/module/auth/rpc/currentSession');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await reread;
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
  test('keeps recovery retryable after a network failure', async ({ page }) => {
    const uncaught: string[] = [];
    page.on('pageerror', (error) => uncaught.push(error.message));
    const endpoint = '**/module/auth/rpc/requestPasswordReset';
    await page.route(endpoint, (route) => route.abort('failed'));
    await page.goto('/app/reset-password');
    await page.getByLabel('Почта').fill('recovery-browser@example.test');
    await page.getByRole('button', { name: 'Отправить ссылку' }).click();

    await expect(page.getByText('Failed to fetch', { exact: true })).toBeVisible();
    await expect(page.getByText('Проверьте почту', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Отправить ссылку' })).toBeEnabled();

    await page.unroute(endpoint);
    await page.getByRole('button', { name: 'Отправить ссылку' }).click();
    await expect(page.getByText('Проверьте почту', { exact: true })).toBeVisible();
    expect(uncaught).toEqual([]);
  });

  test('opens the screen that sets a new password', async ({ page }) => {
    await page.goto('/app/reset-password/confirm?token=' + 'x'.repeat(40));

    await expect(page.getByLabel('Новый пароль')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Изменить пароль' })).toBeVisible();
  });

  test('darkens a link\'s grey underline under the pointer', async ({ page }) => {
    await page.goto('/app/login');
    const link = page.getByRole('link', { name: 'Забыли пароль?' });
    const underline = () => link.evaluate((element) => getComputedStyle(element).textDecorationColor);
    const text = await link.evaluate((element) => getComputedStyle(element).color);
    expect(await underline()).not.toBe(text);
    await link.hover();
    await expect.poll(underline).toBe(text);
  });

  test('says so when the link carries no token, instead of pretending', async ({ page }) => {
    await page.goto('/app/reset-password/confirm');

    await expect(page.getByText('Ссылка неполная')).toBeVisible();
    await expect(page.getByLabel('Новый пароль')).toHaveCount(0);
  });

  test('leads back to sign in from the recovery form', async ({ page }) => {
    await page.goto('/app/reset-password');
    await page.getByRole('link', { name: 'К входу', exact: true }).click();
    await expect(page).toHaveURL(/\/app\/login$/);
  });

  for (const path of ['/app/verify-email', '/app/confirm-email-change']) {
    test(`says in Russian that ${path} came without its token`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByText('Ссылка неполная. Откройте её из письма ровно так, как её прислали.')).toBeVisible();
    });
  }
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
    for (const path of ['/no-such-page', '/about/no-such-page', '/legal/privacy/no-such-page', '/app/no-such-page']) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
      await expect(page.getByRole('heading', { name: 'Такой страницы нет' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'На главную' })).toHaveAttribute('href', '/');
    }
  });

  test('keeps one document and restores the public layout when returning from the application', async ({ page }) => {
    const problems = collectPageErrors(page);
    await page.addInitScript(() => localStorage.setItem('template.app.theme', 'dark'));
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.evaluate(() => Reflect.set(window, '__webDocument', 'same-document'));

    await page.getByRole('link', { name: 'Войти' }).click();
    await page.waitForURL(/\/app\/login/);
    await expect(page.getByLabel('Пароль')).toBeVisible();
    await expect(page.getByRole('link', { name: 'О проекте', exact: true })).toHaveCount(0);
    await expect(page.locator('html')).toHaveClass(/dark/);
    expect(await page.evaluate(() => Reflect.get(window, '__webDocument'))).toBe('same-document');

    await page.goBack();
    await expect(page.getByRole('link', { name: 'О проекте', exact: true })).toBeVisible();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    expect(await page.evaluate(() => Reflect.get(window, '__webDocument'))).toBe('same-document');
    expectNoPageErrors(problems);
  });
});

test.describe('public SSR', () => {
  test.use({ javaScriptEnabled: false });

  test('serves public content and links without browser JavaScript', async ({ page }) => {
    for (const path of ['/', '/about', '/contact']) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Войти' })).toHaveAttribute('href', '/app/');
    }
  });
});
