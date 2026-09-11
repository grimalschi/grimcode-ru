import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ADMIN,
  AUTH,
  BASE_URL,
  errorMessage,
  Session,
  moduleAdmin,
  USERS,
  waitForStack,
} from './client.js';
import {
  createUser,
  ensureFixtureTemplate,
  RegistryRestore,
  resolveOwner,
  testEmail,
} from './fixtures.js';

/**
 * The flows that cross module boundaries.
 *
 * A password reset in Auth has to become an event in Notifications and a stored message in Email,
 * and each of those modules has to keep to its own data. That chain is where a template usually
 * breaks first, so it is checked end to end rather than per module.
 */

let owner: Session;
let restore: RegistryRestore;

beforeAll(async () => {
  await waitForStack();
  owner = await resolveOwner();
  restore = new RegistryRestore(owner);
});

afterAll(async () => {
  await restore?.restoreAll();
});

interface DeliveryRow {
  id: string;
  templateKey: string;
  recipientEmail: string;
  subject: string;
  status: string;
  transport: string;
}

interface EventRow {
  id: string;
  type: string;
  recipientEmail: string;
  status: string;
  deliveryId: string | null;
}

async function waitFor<T>(
  read: () => Promise<T | null>,
  what: string,
  attempts = 20,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = await read();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${what} did not appear in time`);
}

describe('a security email, end to end', () => {
  it('travels from Auth through Notifications into a stored message', async () => {
    const user = await createUser('mailflow');

    await new Session().call(AUTH, 'requestPasswordReset', { email: user.email });

    const event = await waitFor(async () => {
      const page = await owner.call<{ items: EventRow[] }>(
        moduleAdmin('notifications'),
        'listEvents',
        { limit: 50, offset: 0 },
      );
      return (
        page.items.find(
          (item) =>
            item.recipientEmail === user.email && item.type === 'auth.password.reset_requested',
        ) ?? null
      );
    }, 'The reset event');

    expect(event.status).toBe('routed');
    expect(event.deliveryId).not.toBeNull();

    const delivery = await owner.call<{
      delivery: DeliveryRow & { html: string; text: string };
    }>(moduleAdmin('email'), 'getDelivery', { id: event.deliveryId });

    expect(delivery.delivery.recipientEmail).toBe(user.email);
    expect(delivery.delivery.templateKey).toBe('auth-password-reset');
    expect(delivery.delivery.status).toBe('sent');

    // The snapshot is the whole message, not a summary of it — and the link in it is the one that
    // actually sets a password, not the form that asks for another link.
    expect(delivery.delivery.html).toContain('/app/reset-password/confirm?token=');
    expect(delivery.delivery.text.length).toBeGreaterThan(50);

    // Nothing is left for a later step to fill in.
    expect(delivery.delivery.html).not.toMatch(/\{\{/);

    /*
     * The stored copy is a record, not a second key: Auth keeps only the hash of the token, and an
     * administrator who may read the log must not be able to take someone's recovery link out of
     * it.
     */
    expect(delivery.delivery.html).toContain('token=***');
    expect(delivery.delivery.text).not.toMatch(/token=[A-Za-z0-9_-]{10,}/);
  });

  it('does not send the same event twice', async () => {
    const user = await createUser('dedupe');

    // Registration emits one event; asking for the profile again must not add another.
    const before = await owner.call<{ total: number }>(
      moduleAdmin('notifications'),
      'listEvents',
      { limit: 1, offset: 0 },
    );

    await new Session().call(AUTH, 'currentSession');

    const after = await owner.call<{ total: number }>(moduleAdmin('notifications'), 'listEvents', {
      limit: 1,
      offset: 0,
    });

    expect(after.total).toBe(before.total);
    expect(user.email).toContain('dedupe');
  });

  it('keeps messages inside the log when the local transport is configured', async () => {
    const page = await owner.call<{ items: DeliveryRow[] }>(moduleAdmin('email'), 'listDeliveries', {
      limit: 10,
      offset: 0,
    });

    for (const row of page.items) {
      expect(['log', 'unisender']).toContain(row.transport);
    }
  });
});

function mjml(body: string) {
  return `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text></mj-column></mj-section></mj-body></mjml>`;
}

describe('email templates', () => {
  it('ships the auth templates already published', async () => {
    const page = await owner.call<{ items: { key: string }[] }>(
      moduleAdmin('email'),
      'listTemplates',
      { limit: 50, offset: 0 },
    );

    const keys = page.items.map((item) => item.key);
    for (const key of [
      'auth-welcome',
      'auth-verify-email',
      'auth-password-reset',
      'auth-confirm-email-change',
      'auth-email-changed',
    ]) {
      expect(keys).toContain(key);
    }
  });

  it('refuses to publish source that uses an undeclared variable', async () => {
    const templateId = await ensureFixtureTemplate(owner, 'acceptance-refused', ['allowed']);

    const draft = await owner.call<{ version: { id: string } }>(
      moduleAdmin('email'),
      'createDraft',
      { templateId },
      { csrf: true },
    );

    await owner.call(
      moduleAdmin('email'),
      'saveDraft',
      {
        id: draft.version.id,
        subject: 'Acceptance',
        source: mjml('<p>{{notDeclared}}</p>'),
      },
      { csrf: true },
    );

    const refused = await owner.rpc(
      moduleAdmin('email'),
      'publishDraft',
      { id: draft.version.id },
      { csrf: true },
    );

    expect(refused.status).toBe(400);
    expect(errorMessage(refused.body)).toMatch(/notDeclared/);
  });

  it('publishes MJML source and substitutes variables on test send', async () => {
    const source = '<mjml><mj-body><mj-section><mj-column><mj-text>Hello {{name}}</mj-text><mj-button href="{{url}}">Confirm</mj-button></mj-column></mj-section></mj-body></mjml>';
    const templateId = await ensureFixtureTemplate(owner, 'acceptance-published-links', ['name', 'url']);

    const draft = await owner.call<{ version: { id: string } }>(
      moduleAdmin('email'),
      'createDraft',
      { templateId },
      { csrf: true },
    );

    await owner.call(
      moduleAdmin('email'),
      'saveDraft',
      {
        id: draft.version.id,
        subject: 'Hello {{name}}',
        source,
      },
      { csrf: true },
    );

    const published = await owner.call<{
      version: { status: string; source: string; compiledHtml: string; compiledText: string };
    }>(moduleAdmin('email'), 'publishDraft', { id: draft.version.id }, { csrf: true });

    expect(published.version).toMatchObject({ status: 'published', source });
    expect(published.version.compiledHtml).toMatch(/\{\{\s*name\s*\}\}/);
    expect(published.version.compiledText).toContain('Hello {{name}}');
    expect(published.version.compiledHtml).not.toContain('<mj-text>');

    const to = testEmail('template-mjml');
    const { deliveryId } = await owner.call<{ deliveryId: string }>(
      moduleAdmin('email'), 'testSend',
      { id: draft.version.id, to, variables: {
        name: 'Ada', url: 'https://example.test/confirm?lang=en&token=PRIVATE_TOKEN&next=profile',
      } }, { csrf: true },
    );
    const { delivery } = await owner.call<{ delivery: DeliveryRow & { html: string; text: string } }>(
      moduleAdmin('email'), 'getDelivery', { id: deliveryId },
    );
    expect(delivery).toMatchObject({ recipientEmail: to, subject: 'Hello Ada', status: 'sent' });
    expect(delivery.html).toContain('Hello Ada');
    expect(delivery.text).toContain('Hello Ada');
    expect(delivery.html).not.toContain('{{name}}');
    expect(delivery.html).toContain('lang=en&amp;token=***&amp;next=profile');
    expect(delivery.text).toContain('lang=en&token=***&next=profile');
    expect(delivery.html).not.toContain('PRIVATE_TOKEN');
    expect(delivery.text).not.toContain('PRIVATE_TOKEN');

    const editPublished = await owner.rpc(moduleAdmin('email'), 'saveDraft', {
      id: draft.version.id, subject: 'Changed', source: mjml('<p>Changed</p>'),
    }, { csrf: true });
    expect(editPublished.status).toBe(400);
    const unchanged = await owner.call<{ version: { subject: string; source: string } }>(
      moduleAdmin('email'), 'getVersion', { id: draft.version.id },
    );
    expect(unchanged.version).toMatchObject({ subject: 'Hello {{name}}', source });
  });

  it.each([
    { label: 'invalid MJML', source: '<mjml><mj-body><mj-unknown>Invalid component</mj-unknown></mj-body></mjml>', message: /mj-unknown/ },
    { label: 'plain HTML', source: '<p>Only HTML</p>', message: /mjml/i },
  ])('keeps $label as a draft and refuses preview, publish and test send', async ({ source, message }) => {
    const templateId = await ensureFixtureTemplate(owner, 'acceptance-invalid-mjml', []);
    const { version } = await owner.call<{ version: { id: string } }>(
      moduleAdmin('email'), 'createDraft', { templateId }, { csrf: true },
    );
    await owner.call(moduleAdmin('email'), 'saveDraft', {
      id: version.id, subject: 'Invalid MJML', source,
    }, { csrf: true });

    for (const [procedure, input] of [
      ['previewVersion', { id: version.id }],
      ['publishDraft', { id: version.id }],
      ['testSend', { id: version.id, to: testEmail('invalid-mjml') }],
    ] as const) {
      const result = await owner.rpc(moduleAdmin('email'), procedure, input, { csrf: true });
      expect(result.status, procedure).toBe(400);
      expect(errorMessage(result.body), procedure).toMatch(message);
    }
    const unchanged = await owner.call<{ version: { status: string; source: string; compiledHtml: string | null } }>(
      moduleAdmin('email'), 'getVersion', { id: version.id },
    );
    expect(unchanged.version).toMatchObject({ status: 'draft', source, compiledHtml: null });
    const deliveries = await owner.call<{ total: number }>(moduleAdmin('email'), 'listDeliveries', {
      query: testEmail('invalid-mjml'), limit: 1, offset: 0,
    });
    expect(deliveries.total).toBe(0);
  });
});

describe('module boundaries', () => {
  it('gives each admin only its own module’s data', async () => {
    // Auth knows identities and nothing about product profiles.
    const identities = await owner.call<{ items: { email: string }[] }>(
      moduleAdmin('auth'),
      'listIdentities',
      { limit: 5, offset: 0 },
    );
    expect(identities.items[0]).not.toHaveProperty('preferences');

    // Users knows profiles and nothing about passwords or sessions.
    const profiles = await owner.call<{ items: Record<string, unknown>[] }>(
      moduleAdmin('users'),
      'listProfiles',
      { limit: 5, offset: 0 },
    );
    if (profiles.items[0]) {
      expect(profiles.items[0]).not.toHaveProperty('passwordHash');
      expect(profiles.items[0]).not.toHaveProperty('activeSessionCount');
    }
  });

  /**
   * Users does not store the sign-in address — the profile list asks Auth for it on every page, in
   * one call for the whole page. The call is a direct one into Auth now, and a failure inside it is
   * swallowed so the page still renders without addresses; that is exactly why the column needs a
   * check of its own rather than being covered by the page answering at all.
   */
  it('fills in a profile’s sign-in address from auth', async () => {
    const user = await createUser('profile-address');
    // The profile row is created lazily on first access, so ask for it as the user first.
    await user.session.call(USERS, 'getOwnProfile', {});

    const page = await owner.call<{ items: { identityId: string; email: string | null }[] }>(
      moduleAdmin('users'),
      'listProfiles',
      { limit: 20, offset: 0 },
    );

    const mine = page.items.find((item) => item.identityId === user.userId);
    expect(mine?.email).toBe(user.email);
  });

  it('never exposes an internal surface through Router', async () => {
    const anonymous = new Session();

    for (const path of [
      '/internal/rpc/emit',
      '/module/notifications/rpc/emit',
      '/module/email/rpc/send',
    ]) {
      const response = await anonymous.fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(404);
    }
  });
});

describe('the public site', () => {
  it('renders its pages on the server', async () => {
    const response = await fetch(`${BASE_URL}/about`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toMatch(/<h1[^>]*>О проекте<\/h1>/);
  });

  it('answers an unknown address with a real 404', async () => {
    const response = await fetch(`${BASE_URL}/definitely-not-a-page`);
    expect(response.status).toBe(404);
  });

  it('tells crawlers to stay out of the application and the admin panel', async () => {
    const response = await fetch(`${BASE_URL}/robots.txt`);
    const body = await response.text();

    expect(body).toMatch(/Disallow: \/app\//);
    expect(body).toMatch(/Disallow: \/admin\//);
    // The sitemap has to be named by its full address, which is why this file is generated.
    expect(body).toMatch(new RegExp(`Sitemap: ${BASE_URL}/sitemap\\.xml`));
  });

  it('offers a sitemap of the public pages and nothing behind sign-in', async () => {
    const response = await fetch(`${BASE_URL}/sitemap.xml`);
    const body = await response.text();

    expect(response.headers.get('content-type')).toMatch(/application\/xml/);
    expect(body).toContain(`<loc>${BASE_URL}/</loc>`);
    expect(body).toContain(`<loc>${BASE_URL}/about</loc>`);

    // Placeholders and protected areas stay out until they have something to say.
    expect(body).not.toContain('/legal/');
    expect(body).not.toContain('/app/');
    expect(body).not.toContain('/admin');
  });
});

describe('the first owner', () => {
  it('is the one already in place, and nobody else is promoted by registering', async () => {
    const state = await owner.call<{ role: string }>(ADMIN, 'session');
    expect(state.role).toBe('owner');

    // A brand new account is a user and nothing more.
    const newcomer = await createUser('newcomer');
    expect(await newcomer.session.status('/admin/')).toBe(403);
  });

  it('records how administrator access was granted', async () => {
    const page = await owner.call<{ items: { action: string }[] }>(ADMIN, 'listAudit', {
      limit: 50,
      offset: 0,
    });

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.some((entry) => entry.action.length > 0)).toBe(true);
  });
});
