import { randomUUID } from 'node:crypto';

import { ADMIN, AUTH, Session } from './client.js';

/**
 * Fixtures for the acceptance suite.
 *
 * Every run creates its own accounts under a unique prefix and puts back whatever it changed, so
 * running the suite against a shared development stack does not leave it with new administrators
 * or with an existing one holding fewer grants than before.
 */

export const RUN_ID = randomUUID().slice(0, 8);

/** A password that satisfies the service's own rule without being interesting. */
export const PASSWORD = `acceptance-${RUN_ID}-passphrase`;

export interface TestUser {
  email: string;
  userId: string;
  session: Session;
}

export function testEmail(label: string): string {
  return `acceptance+${RUN_ID}-${label}@example.test`;
}

/** Registers a fresh account and returns a session already signed in as it. */
export async function createUser(label: string): Promise<TestUser> {
  const session = new Session();
  const email = testEmail(label);

  const result = await session.call<{ identity: { id: string } }>(AUTH, 'register', {
    email,
    password: PASSWORD,
  });

  return { email, userId: result.identity.id, session };
}

export async function signIn(email: string, password = PASSWORD): Promise<Session> {
  const session = new Session();
  await session.call(AUTH, 'login', { email, password });
  return session;
}

/**
 * The owner the suite works as.
 *
 * On an empty stack the first account registered becomes the owner, which is exactly the rule
 * under test; on a stack that already has one, its credentials have to be supplied.
 */
export async function resolveOwner(): Promise<Session> {
  const email = process.env.ACCEPTANCE_OWNER_EMAIL;
  const password = process.env.ACCEPTANCE_OWNER_PASSWORD;

  if (email && password) {
    const session = await signIn(email, password);
    const state = await session.call<{ role: string }>(ADMIN, 'session');
    if (state.role !== 'owner') {
      throw new Error(`ACCEPTANCE_OWNER_EMAIL (${email}) is not the owner but ${state.role}`);
    }
    return session;
  }

  // No credentials given: this only works on a stack with no accounts yet, where registering makes
  // the first owner.
  const candidate = await createUser('owner');
  const state = await candidate.session.rpc<{ role?: string }>(ADMIN, 'session');

  if (state.status === 200 && state.body.role === 'owner') return candidate.session;

  throw new Error(
    'This stack already has accounts, so the suite cannot become the owner by registering. ' +
      'Set ACCEPTANCE_OWNER_EMAIL and ACCEPTANCE_OWNER_PASSWORD.',
  );
}

/**
 * A template the suite may write to.
 *
 * It is looked up by a stable key and created only when missing, so running the suite a hundred
 * times leaves one extra template rather than a hundred. Email has no delete operation on purpose
 * — a template key is what code refers to, and removing one silently would break a send — so
 * reuse is what keeps a shared stack tidy.
 */
export async function ensureFixtureTemplate(
  owner: Session,
  key: string,
  variables: string[],
): Promise<string> {
  const page = await owner.call<{ items: { id: string; key: string }[] }>(
    '/admin/embed/service/email',
    'listTemplates',
    { query: key, limit: 50, offset: 0 },
  );

  const existing = page.items.find((item) => item.key === key);
  if (existing) return existing.id;

  const created = await owner.call<{ template: { id: string } }>(
    '/admin/embed/service/email',
    'createTemplate',
    {
      key,
      name: 'Acceptance fixture',
      description: 'Created by the acceptance suite. Safe to delete.',
      variables,
    },
    { csrf: true },
  );

  return created.template.id;
}

export interface Administrator {
  userId: string;
  email: string;
  role: 'owner' | 'admin';
  enabled: boolean;
  grants: string[];
}

/**
 * Remembers how an administrator looked, so a test that changes access can put it back.
 *
 * The registry has no delete operation on purpose — removing the record of who had access would
 * defeat the audit — so an administrator this suite created is left disabled with no grants, which
 * is the closest thing to never having existed.
 */
export class RegistryRestore {
  private before = new Map<string, Administrator | null>();

  constructor(private readonly owner: Session) {}

  async remember(userId: string): Promise<void> {
    if (this.before.has(userId)) return;

    const page = await this.owner.call<{ items: Administrator[] }>(ADMIN, 'listAdministrators', {
      limit: 100,
      offset: 0,
    });

    this.before.set(userId, page.items.find((item) => item.userId === userId) ?? null);
  }

  async restoreAll(): Promise<void> {
    for (const [userId, previous] of this.before) {
      if (previous) {
        await this.owner.call(
          ADMIN,
          'updateAdministrator',
          { userId, role: previous.role, enabled: previous.enabled, grants: previous.grants },
          { csrf: true },
        );
      } else {
        // Created by this run: disabled and stripped, so no account is left with access.
        await this.owner
          .call(ADMIN, 'updateAdministrator', { userId, enabled: false, grants: [] }, { csrf: true })
          .catch(() => undefined);
      }
    }

    this.before.clear();
  }
}
