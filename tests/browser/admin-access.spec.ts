import { createServer } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN, BASE_URL, moduleAdmin, waitForStack, type Session } from '../src/client.js';
import {
  createUser, ensureFixtureTemplate, PASSWORD, RegistryRestore, resolveOwner, type TestUser,
} from '../src/fixtures.js';
import { collectPageErrors, expectNoPageErrors } from './support.js';

let owner: Session;
let restore: RegistryRestore;
let users: Record<string, TestUser>;
let templateId: string;

const grants: Record<string, string[]> = { empty: [], email: ['email'], users: ['users'], disabled: ['email'] };

async function signInAs(page: Page, user: TestUser): Promise<void> {
  await page.goto('/app/login');
  await page.getByLabel('Почта').fill(user.email);
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/app/login'));
}

test.beforeAll(async () => {
  await waitForStack();
  owner = await resolveOwner();
  restore = new RegistryRestore(owner);
  users = {};
  for (const [name, modules] of Object.entries(grants)) {
    const user = await createUser(`browser-${name}`);
    users[name] = user;
    await restore.remember(user.userId);
    await owner.call(ADMIN, 'addAdministrator', { email: user.email, role: 'admin', grants: modules }, { csrf: true });
  }
  await owner.call(ADMIN, 'updateAdministrator', { userId: users.disabled!.userId, enabled: false }, { csrf: true });
  templateId = await ensureFixtureTemplate(owner, 'browser-access-controls', []);
});

test.afterAll(async () => {
  await restore?.restoreAll();
});

for (const role of ['empty', 'email', 'users']) {
  test(`${role} administrator sees only granted modules and cannot open owner screens`, async ({ page }) => {
    const problems = collectPageErrors(page);
    await signInAs(page, users[role]!);
    await page.goto('/admin/');
    await expect(page.getByRole('heading', { name: 'Админка', exact: true })).toBeVisible();
    for (const name of ['Email', 'Notifications', 'Auth', 'Users']) {
      await expect(page.getByRole('link', { name, exact: true })).toHaveCount(grants[role]!.includes(name.toLowerCase()) ? 1 : 0);
    }
    for (const name of ['Администраторы', 'Журнал', 'База данных']) {
      await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
    }
    if (role !== 'empty') {
      await page.getByRole('link', { name: role === 'email' ? 'Email' : 'Users', exact: true }).click();
      const frame = page.frameLocator('iframe');
      await expect(frame.getByRole('heading', { name: role === 'email' ? 'Шаблоны' : 'Профили', exact: true })).toBeVisible();
    }
    for (const path of ['/admin/administrators', '/admin/audit', '/admin/database']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/admin\/?$/);
      await expect(page.getByRole('heading', { name: 'Админка', exact: true })).toBeVisible();
    }
    await page.goto('/admin/module/auth');
    await expect(page.getByText('Такого модуля нет.', { exact: true })).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);
    expectNoPageErrors(problems);
  });
}

test('disabled administrators keep product access but cannot open the panel', async ({ page }) => {
  await signInAs(page, users.disabled!);
  const response = await page.goto('/admin/');
  expect(response?.status()).toBe(403);
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  const identity = await page.request.post('/module/auth/rpc/currentSession', { data: {} });
  expect(identity.status()).toBe(200);
  expect((await identity.json()).result.data.identity.id).toBe(users.disabled!.userId);
});

test('an open module loses HTTP access after revocation and disappears on reload', async ({ page }) => {
  await signInAs(page, users.users!);
  await page.goto('/admin/module/users');
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Профили', exact: true })).toBeVisible();
  try {
    await owner.call(ADMIN, 'updateAdministrator', { userId: users.users!.userId, grants: [] }, { csrf: true });
    const response = await page.request.post(`${moduleAdmin('users')}/rpc/listProfiles`, { data: {} });
    expect(response.status()).toBe(403);
    await page.reload();
    await expect(page.getByText('Такого модуля нет.', { exact: true })).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
  } finally {
    await owner.call(ADMIN, 'updateAdministrator', { userId: users.users!.userId, grants: ['users'] }, { csrf: true });
  }
});

test('a different origin cannot read CSRF or modify module data through the browser', async ({ page }) => {
  await signInAs(page, users.email!);
  const prefix = moduleAdmin('email');
  const original = await owner.call<{ template: { name: string } }>(prefix, 'getTemplate', { id: templateId });
  const foreign = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html', connection: 'close' });
    response.end('<!doctype html><title>Other origin</title>');
  });
  await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  try {
    const address = foreign.address();
    if (!address || typeof address === 'string') throw new Error('Local server has no TCP address');
    await page.goto(`http://127.0.0.1:${address.port}`);
    const result = await page.evaluate(async ({ base, prefix, id }) => {
      let tokenRead = false;
      let mutationReadable = false;
      try {
        await fetch(`${base}${prefix}/csrf`, { credentials: 'include' }).then((response) => response.json());
        tokenRead = true;
      } catch { /* Browser must enforce the origin boundary. */ }
      try {
        await fetch(`${base}${prefix}/rpc/updateTemplate`, {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-csrf-token': 'untrusted' },
          body: JSON.stringify({ id, name: 'Forbidden cross-origin edit' }),
        });
        mutationReadable = true;
      } catch { /* The preflight must not authorize the foreign origin. */ }
      await fetch(`${base}${prefix}/rpc/updateTemplate`, {
        method: 'POST', mode: 'no-cors', credentials: 'include',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ id, name: 'Forbidden simple-request edit' }),
      });
      return { tokenRead, mutationReadable };
    }, { base: BASE_URL, prefix, id: templateId });
    expect(result).toEqual({ tokenRead: false, mutationReadable: false });
    const after = await owner.call<{ template: { name: string } }>(prefix, 'getTemplate', { id: templateId });
    expect(after.template.name).toBe(original.template.name);
  } finally {
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
  }
});
