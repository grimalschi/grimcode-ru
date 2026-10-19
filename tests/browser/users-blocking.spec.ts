import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { ADMIN, USERS, waitForStack, type Session } from '../src/client.js';
import { createUser, PASSWORD, RegistryRestore, resolveOwner, type TestUser } from '../src/fixtures.js';
import { collectPageErrors, expectNoPageErrors, signIn } from './support.js';

/**
 * Blocking an account from the Users screen in the panel: the owner's button in the list of
 * people, Auth's refusal for the panel's owners, and nothing of it for an administrator with the grant.
 */
let owner: Session;
let restore: RegistryRestore;
let person: TestUser;
let grantee: TestUser;

async function signInAs(page: Page, user: TestUser): Promise<void> {
  await page.goto('/app/login');
  await page.getByLabel('Почта').fill(user.email);
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/app/login'));
}

const frame = (page: Page): FrameLocator => page.frameLocator('iframe[title="Админка Профили"]');

async function openProfiles(page: Page, email: string) {
  await page.goto('/admin/module/users#/');
  await expect(frame(page).getByRole('heading', { name: 'Профили', exact: true })).toBeVisible();
  // The list is searched by name; the address is found through the row text instead.
  return frame(page).getByRole('row').filter({ hasText: email });
}

test.beforeAll(async () => {
  await waitForStack();
  owner = await resolveOwner();
  restore = new RegistryRestore(owner);
  // The list shows profiles, and a profile appears with the product's first screen: the owner of a
  // fresh test installation has none until asked for — exactly the "registered, never entered" case.
  await owner.call(USERS, 'getOwnProfile');
  // A person with a profile and an administrator granted Users.
  person = await createUser('browser-blocked');
  await person.session.call(USERS, 'getOwnProfile');
  grantee = await createUser('browser-users-grantee');
  await grantee.session.call(USERS, 'getOwnProfile');
  await restore.remember(grantee.userId);
  await owner.call(ADMIN, 'addAdministrator', { email: grantee.email, role: 'admin', grants: ['users'] }, { csrf: true });
});

test.afterAll(async () => {
  await restore?.restoreAll();
});

test('the owner blocks a person from the profile list, with a confirmation, and unblocks them again', async ({ page }) => {
  const problems = collectPageErrors(page);
  await signIn(page);
  const row = await openProfiles(page, person.email);
  await expect(row.getByText('Нет', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: `Заблокировать ${person.email}`, exact: true }).click();
  const confirm = frame(page).getByRole('dialog', { name: /^Заблокировать / });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Заблокировать', exact: true }).click();
  await expect(frame(page).getByText('Аккаунт заблокирован', { exact: true })).toBeVisible();
  await expect(row.getByText(/^С \d/)).toBeVisible();
  // Blocked means out: the person's session is gone.
  expect((await person.session.rpc(USERS, 'getOwnProfile')).status).toBe(401);

  await row.getByRole('button', { name: `Разблокировать ${person.email}`, exact: true }).click();
  await expect(frame(page).getByText('Аккаунт разблокирован', { exact: true })).toBeVisible();
  await expect(row.getByText('Нет', { exact: true })).toBeVisible();
  expectNoPageErrors(problems);
});

test('the owner is offered no blocking of their own account, nor of another owner', async ({ page }) => {
  const second = await createUser('browser-second-owner');
  await second.session.call(USERS, 'getOwnProfile');
  await restore.remember(second.userId);
  await owner.call(ADMIN, 'addAdministrator', { email: second.email, role: 'owner', grants: [] }, { csrf: true });
  try {
    await signIn(page);
    const own = await openProfiles(page, (await owner.call<{ email: string }>(ADMIN, 'session')).email);
    const ownButton = own.getByRole('button', { name: /^Заблокировать / });
    await expect(ownButton).toBeDisabled();
    await expect(ownButton).toHaveAttribute('title', 'Нельзя заблокировать собственный аккаунт');
    const other = frame(page).getByRole('row').filter({ hasText: second.email });
    const otherButton = other.getByRole('button', { name: `Заблокировать ${second.email}`, exact: true });
    await expect(otherButton).toBeDisabled();
    await expect(otherButton).toHaveAttribute('title', /сначала снимите роль/);
  } finally {
    await owner.call(ADMIN, 'updateAdministrator', { userId: second.userId, role: 'admin', enabled: false, grants: [] }, { csrf: true });
  }
});

test('an administrator granted Users sees the list without any blocking', async ({ page }) => {
  await signInAs(page, grantee);
  const row = await openProfiles(page, person.email);
  await expect(row).toBeVisible();
  await expect(frame(page).getByRole('button', { name: /^(Заблокировать|Разблокировать) / })).toHaveCount(0);
  await expect(frame(page).getByRole('columnheader', { name: 'Блокировка', exact: true })).toBeVisible();
});
