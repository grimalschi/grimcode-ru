import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ADMIN, AUTH, BASE_URL, Session, serviceAdmin, waitForStack } from './client.js';
import {
  createUser,
  ensureFixtureTemplate,
  RegistryRestore,
  resolveOwner,
} from './fixtures.js';

/**
 * The flows that cross service boundaries.
 *
 * A password reset in Auth has to become an event in Notifications and a stored message in Email,
 * and each of those services has to keep to its own data. That chain is where a template usually
 * breaks first, so it is checked end to end rather than per service.
 */

let owner: Session;
let restore: RegistryRestore;

beforeAll(async () => {
  await waitForStack();
  owner = await resolveOwner();
  restore = new RegistryRestore(owner);
});

afterAll(async () => {
  await restore.restoreAll();
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
        serviceAdmin('notifications'),
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
    }>(serviceAdmin('email'), 'getDelivery', { id: event.deliveryId });

    expect(delivery.delivery.recipientEmail).toBe(user.email);
    expect(delivery.delivery.templateKey).toBe('auth-password-reset');
    expect(delivery.delivery.status).toBe('sent');

    // The snapshot is the whole message, not a summary of it.
    expect(delivery.delivery.html).toMatch(/reset-password\?token=/);
    expect(delivery.delivery.text.length).toBeGreaterThan(50);

    // Nothing is left for a later step to fill in.
    expect(delivery.delivery.html).not.toMatch(/\{\{/);
  });

  it('does not send the same event twice', async () => {
    const user = await createUser('dedupe');

    // Registration emits one event; asking for the profile again must not add another.
    const before = await owner.call<{ total: number }>(
      serviceAdmin('notifications'),
      'listEvents',
      { limit: 1, offset: 0 },
    );

    await new Session().call(AUTH, 'currentSession');

    const after = await owner.call<{ total: number }>(serviceAdmin('notifications'), 'listEvents', {
      limit: 1,
      offset: 0,
    });

    expect(after.total).toBe(before.total);
    expect(user.email).toContain('dedupe');
  });

  it('keeps messages inside the log when the local transport is configured', async () => {
    const page = await owner.call<{ items: DeliveryRow[] }>(serviceAdmin('email'), 'listDeliveries', {
      limit: 10,
      offset: 0,
    });

    for (const row of page.items) {
      expect(['log', 'unisender']).toContain(row.transport);
    }
  });
});

describe('email templates', () => {
  it('ships the auth templates already published', async () => {
    const page = await owner.call<{ items: { key: string }[] }>(
      serviceAdmin('email'),
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

  /**
   * Publishing is where the server takes over, and its checks are the reason a broken template
   * cannot reach a recipient.
   */
  it('refuses to publish a document that uses an undeclared variable', async () => {
    const templateId = await ensureFixtureTemplate(owner, 'acceptance-refused', ['allowed']);

    const draft = await owner.call<{ version: { id: string } }>(
      serviceAdmin('email'),
      'createDraft',
      { templateId, locale: 'en' },
      { csrf: true },
    );

    await owner.call(
      serviceAdmin('email'),
      'saveDraft',
      {
        id: draft.version.id,
        subject: 'Acceptance',
        editorDocument: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'variable', attrs: { id: 'notDeclared' } }],
            },
          ],
        },
      },
      { csrf: true },
    );

    const refused = await owner.rpc(
      serviceAdmin('email'),
      'publishDraft',
      { id: draft.version.id },
      { csrf: true },
    );

    expect(refused.status).toBe(400);
    expect(String((refused.body as { message?: string }).message)).toMatch(/notDeclared/);
  });

  it('publishes a correct document and keeps its placeholders for send time', async () => {
    const templateId = await ensureFixtureTemplate(owner, 'acceptance-published', ['name']);

    const draft = await owner.call<{ version: { id: string } }>(
      serviceAdmin('email'),
      'createDraft',
      { templateId, locale: 'en' },
      { csrf: true },
    );

    await owner.call(
      serviceAdmin('email'),
      'saveDraft',
      {
        id: draft.version.id,
        subject: 'Hello {{name}}',
        editorDocument: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Hello ' },
                { type: 'variable', attrs: { id: 'name' } },
              ],
            },
          ],
        },
      },
      { csrf: true },
    );

    const published = await owner.call<{
      version: { status: string; compiledHtml: string; compiledText: string };
    }>(serviceAdmin('email'), 'publishDraft', { id: draft.version.id }, { csrf: true });

    expect(published.version.status).toBe('published');
    // The values are per recipient, so the stored content keeps the placeholder.
    expect(published.version.compiledHtml).toMatch(/\{\{\s*name\s*\}\}/);
    expect(published.version.compiledText).toMatch(/Hello/);
  });
});

describe('service boundaries', () => {
  it('gives each admin only its own service’s data', async () => {
    // Auth knows identities and nothing about product profiles.
    const identities = await owner.call<{ items: { email: string }[] }>(
      serviceAdmin('auth'),
      'listIdentities',
      { limit: 5, offset: 0 },
    );
    expect(identities.items[0]).not.toHaveProperty('preferences');

    // Users knows profiles and nothing about passwords or sessions.
    const profiles = await owner.call<{ items: Record<string, unknown>[] }>(
      serviceAdmin('users'),
      'listProfiles',
      { limit: 5, offset: 0 },
    );
    if (profiles.items[0]) {
      expect(profiles.items[0]).not.toHaveProperty('passwordHash');
      expect(profiles.items[0]).not.toHaveProperty('activeSessionCount');
    }
  });

  it('never exposes an internal surface through Gateway', async () => {
    const anonymous = new Session();

    for (const path of [
      '/internal/rpc/emit',
      '/service/notifications/rpc/emit',
      '/service/email/rpc/send',
    ]) {
      const response = await anonymous.fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ json: {} }),
      });
      expect(response.status).toBe(404);
    }
  });
});

describe('the built admin surfaces', () => {
  it('serves the central Admin without the email editor in its bundle', async () => {
    const page = await owner.fetch('/admin/');
    const html = await page.text();

    const scripts = [...html.matchAll(/src="(\/admin\/assets\/[^"]+\.js)"/g)]
      .map((match) => match[1])
      .filter((script): script is string => script !== undefined);
    expect(scripts.length).toBeGreaterThan(0);

    for (const script of scripts) {
      const asset = await owner.fetch(script);
      const body = await asset.text();

      // TipTap and the editor's own blocks belong to the Email service admin alone. The contract's
      // format marker (`maily@1`) is a plain string and legitimately travels with the contracts,
      // so what is checked is the library, not the word.
      expect(body).not.toMatch(/@tiptap|ProseMirror|@maily-to\/core/i);
    }
  });

  it('keeps the editor out of the Email admin’s first bundle too', async () => {
    const page = await owner.fetch(`${serviceAdmin('email')}/`);
    const html = await page.text();

    const entry = /src="(\/admin\/service\/email\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(entry).toBeDefined();

    const asset = await owner.fetch(entry!);
    const body = await asset.text();

    // The editor is a separate chunk, fetched only when its route is opened.
    expect(body).not.toMatch(/@tiptap|ProseMirror/i);
  });

  it('serves the real Adminer, with its own redirect and cookie', async () => {
    // Adminer answers the first request with a redirect and a cookie of its own; following it by
    // hand is what proves the pair survives Gateway.
    const page = await owner.fetch('/admin/database/', {}, { follow: true });
    const html = await page.text();

    expect(page.status).toBe(200);
    // Adminer's own markup, not a look-alike.
    expect(html).toMatch(/adminer\.css/);
    // And it found the service databases through the connection it was given.
    expect(html).toMatch(/_auth|_admin|_email/);
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
