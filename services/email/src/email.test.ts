import { describe, expect, it } from 'vitest';

import {
  assertDeclaredVariables,
  collectVariables,
  escapeHtml,
  fillHtml,
  fillText,
  htmlToText,
  redactOneTimeTokens,
  renderMessage,
  renderSubject,
  sanitizeHtml,
  TemplateRenderError,
} from './render.js';
import { SEED_TEMPLATES } from './seed.js';
import { createLogTransport, createUniSenderTransport } from './transport.js';
import type { EditorDocument } from './types.js';

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

describe('variable collection', () => {
  it('finds variables in text and in a button url', () => {
    const document: EditorDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'variable', attrs: { id: 'email' } }],
        },
        {
          type: 'button',
          attrs: { text: 'Go', isTextVariable: false, url: 'resetUrl', isUrlVariable: true },
        },
      ],
    };
    expect(collectVariables(document)).toEqual(['email', 'resetUrl']);
  });

  it('refuses a document using a variable the template does not declare', () => {
    const document: EditorDocument = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'variable', attrs: { id: 'secret' } }] }],
    };
    expect(() => assertDeclaredVariables(document, ['email'])).toThrow(TemplateRenderError);
    expect(() => assertDeclaredVariables(document, ['secret'])).not.toThrow();
  });
});

describe('sanitizing', () => {
  it('removes scripts, frames and inline handlers', () => {
    const dirty = `<p onclick="steal()">hi</p><script>bad()</script><iframe src="x"></iframe>`;
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('<iframe');
    expect(clean).not.toContain('onclick');
    expect(clean).toContain('hi');
  });

  it('defuses a javascript: link', () => {
    expect(sanitizeHtml(`<a href="javascript:alert(1)">x</a>`)).toContain('href="#"');
  });
});

describe('placeholder filling', () => {
  it('escapes values on the way into HTML but not into text', () => {
    const value = { name: '<b>Ada</b> & co' };
    expect(fillHtml('<p>{{name}}</p>', value)).toBe('<p>&lt;b&gt;Ada&lt;/b&gt; &amp; co</p>');
    expect(fillText('Hello {{name}}', value)).toBe('Hello <b>Ada</b> & co');
  });

  it('leaves an unknown placeholder visible instead of blanking it', () => {
    expect(fillHtml('<p>{{missing}}</p>', {})).toBe('<p>{{missing}}</p>');
    expect(renderSubject('Hi {{name}}', {})).toBe('Hi {{name}}');
  });

  it('escapes ampersands in a link, which is what an href needs anyway', () => {
    expect(escapeHtml('https://x.test/a?b=1&c=2')).toBe('https://x.test/a?b=1&amp;c=2');
  });
});

describe('plain text generation', () => {
  it('derives the text version from the produced HTML', () => {
    const text = htmlToText('<h1>Title</h1><p>Line one</p><p>Line two</p>');
    expect(text).toContain('Title');
    expect(text).toContain('Line one');
    expect(text).not.toContain('<p>');
  });

  it('skips hidden preheader content', () => {
    expect(htmlToText('<p hidden>preheader</p><p>body</p>')).toBe('body');
  });
});

describe('seed templates', () => {
  it('declares every variable its document uses', () => {
    for (const seed of SEED_TEMPLATES) {
      expect(() => assertDeclaredVariables(seed.document, seed.variables)).not.toThrow();
    }
  });

  it('covers the auth events the template ships with', () => {
    expect(SEED_TEMPLATES.map((seed) => seed.key).sort()).toEqual([
      'auth-confirm-email-change',
      'auth-email-changed',
      'auth-password-reset',
      'auth-verify-email',
      'auth-welcome',
    ]);
  });

  it('publishes with variables left as placeholders, because values are per recipient', async () => {
    const seed = SEED_TEMPLATES.find((entry) => entry.key === 'auth-password-reset');
    const compiled = await renderMessage(seed!.document, seed!.subject);

    expect(compiled.html).toContain('{{resetUrl}}');
    expect(compiled.html).toContain('{{email}}');
    expect(compiled.text).toContain('{{resetUrl}}');

    // ...and a real delivery fills them in.
    const html = fillHtml(compiled.html, {
      email: 'user@example.com',
      resetUrl: 'https://example.test/app/reset-password?token=abc',
    });
    expect(html).toContain('user@example.com');
    expect(html).toContain('reset-password?token=abc');
    expect(html).not.toContain('{{');
  });

  /**
   * The renderer escapes values itself. Escaping them here as well turned every `&` in a link into
   * `&amp;amp;`, precisely where someone looks to check a message before sending it.
   */
  it('escapes a value exactly once', async () => {
    const preview = await renderMessage(
      {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'variable', attrs: { id: 'url' } }] }],
      },
      'Тема',
      { url: 'https://example.test/r?a=1&b=2' },
    );

    expect(preview.html).toContain('a=1&amp;b=2');
    expect(preview.html).not.toContain('&amp;amp;');
    expect(preview.text).toContain('a=1&b=2');
  });

  it('still keeps markup in a value from becoming markup', async () => {
    const preview = await renderMessage(
      {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'variable', attrs: { id: 'name' } }] }],
      },
      'Тема',
      { name: '<script>alert(1)</script>' },
    );

    expect(preview.html).not.toContain('<script>alert');
  });

  /**
   * Auth keeps only the hash of a one-time token, so the delivery log must not keep the token
   * itself: an administrator who may read messages could otherwise ask for a reset of someone
   * else's password and take the link out of the log.
   */
  it('keeps one-time tokens out of the stored copy', () => {
    const sent = '<a href="https://x.test/app/reset-password/confirm?token=SECRET123">Ссылка</a>';
    const stored = redactOneTimeTokens(sent);

    expect(stored).toContain('token=***');
    expect(stored).not.toContain('SECRET123');
    // Everything else about the message survives, so the record is still worth keeping.
    expect(stored).toContain('/app/reset-password/confirm');
  });

  /**
   * A preview or a test send rarely carries every value. What is missing has to stay a visible
   * placeholder: the renderer's own fallback is the bare variable name, which turned a button's
   * link into `href="resetUrl"` — a relative link to nowhere.
   */
  it('keeps a placeholder for a value the preview does not carry', async () => {
    const seed = SEED_TEMPLATES.find((entry) => entry.key === 'auth-password-reset');
    const preview = await renderMessage(seed!.document, seed!.subject, {
      email: 'user@example.com',
    });

    expect(preview.html).toContain('user@example.com');
    expect(preview.html).toContain('href="{{resetUrl}}"');
    expect(preview.html).not.toContain('href="resetUrl"');
  });

  it('renders a preview with sample values filled in', async () => {
    const seed = SEED_TEMPLATES.find((entry) => entry.key === 'auth-welcome');
    const preview = await renderMessage(seed!.document, seed!.subject, {
      email: 'user@example.com',
      verificationUrl: 'https://example.test/app/verify-email?token=abc',
    });

    expect(preview.html).toContain('user@example.com');
    expect(preview.text).toContain('user@example.com');
  });
});

describe('transports', () => {
  it('keeps local messages inside the delivery log', async () => {
    const result = await createLogTransport(logger).send({
      dedupeKey: 'k',
      to: 'a@example.com',
      subject: 's',
      html: '<p>h</p>',
      text: 'h',
    });
    expect(result.providerStatus).toBe('logged');
  });

  it('refuses to send through UniSender Go without credentials', async () => {
    delete process.env.UNISENDER_GO_API_KEY;
    const transport = createUniSenderTransport(async () => new Response('{}'));
    await expect(
      transport.send({ dedupeKey: 'k', to: 'a@example.com', subject: 's', html: '', text: '' }),
    ).rejects.toThrow(/not configured/);
  });

  it('passes the dedupe key to the provider as its idempotency key', async () => {
    process.env.UNISENDER_GO_API_KEY = 'test-key';
    process.env.EMAIL_FROM_ADDRESS = 'no-reply@example.com';

    let body: unknown;
    const transport = createUniSenderTransport(async (_url, init) => {
      body = JSON.parse(String((init as RequestInit).body));
      return new Response(JSON.stringify({ status: 'success', job_id: 'job-1' }), { status: 200 });
    });

    const result = await transport.send({
      dedupeKey: 'delivery-42',
      to: 'a@example.com',
      subject: 's',
      html: '<p>h</p>',
      text: 'h',
    });

    expect(result.providerMessageId).toBe('job-1');
    expect(body).toMatchObject({ message: { idempotence_key: 'delivery-42', track_links: 0 } });

    delete process.env.UNISENDER_GO_API_KEY;
    delete process.env.EMAIL_FROM_ADDRESS;
  });

  it('reports a rejected recipient as a failure', async () => {
    process.env.UNISENDER_GO_API_KEY = 'test-key';
    process.env.EMAIL_FROM_ADDRESS = 'no-reply@example.com';

    const transport = createUniSenderTransport(
      async () =>
        new Response(JSON.stringify({ status: 'success', failed_emails: { 'a@example.com': 'invalid' } })),
    );

    await expect(
      transport.send({ dedupeKey: 'k', to: 'a@example.com', subject: 's', html: '', text: '' }),
    ).rejects.toThrow(/rejected the recipient/);

    delete process.env.UNISENDER_GO_API_KEY;
    delete process.env.EMAIL_FROM_ADDRESS;
  });
});
