import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { templateVersionSchema } from './schemas.js';

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
import { RPC_TIMEOUT_MS } from './rpc.js';

import { createTransport, createUniSenderTransport, PROVIDER_TIMEOUT_MS } from './transport.js';
import type { MailSettings } from './transport.js';

/** Settings of a configured provider, as the composer would hand them over. */
const configured: MailSettings = {
  provider: 'unisender',
  apiKey: 'test-key',
  fromAddress: 'no-reply@example.com',
};

function mjml(body: string): string {
  return `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text></mj-column></mj-section></mj-body></mjml>`;
}

describe('transports', () => {
  it.each([undefined, '', 'log'])('keeps provider %s local without sending', async (provider) => {
    const fetchFn = vi.fn<typeof fetch>();
    const transport = createTransport({ provider }, fetchFn);
    const result = await transport.send({
      dedupeKey: 'k',
      to: 'a@example.com',
      subject: 's',
      html: '<p>h</p>',
      text: 'h',
    });
    expect(transport.name).toBe('log');
    expect(result.providerStatus).toBe('logged');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    { missing: { apiKey: '' }, variable: 'UNISENDER_GO_API_KEY' },
    { missing: { apiKey: undefined }, variable: 'UNISENDER_GO_API_KEY' },
    { missing: { fromAddress: '' }, variable: 'EMAIL_FROM_ADDRESS' },
    { missing: { fromAddress: undefined }, variable: 'EMAIL_FROM_ADDRESS' },
  ])('refuses to send when $variable is empty or unset', async ({ missing, variable }) => {
    const fetchFn = vi.fn<typeof fetch>();
    expect(() => createUniSenderTransport({ ...configured, ...missing }, fetchFn)).toThrow(`UniSender Go is not configured: ${variable} missing`);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a misspelled provider at startup', () => {
    expect(() => createTransport({ provider: 'unisenderr' })).toThrow('Unknown EMAIL_PROVIDER');
  });

  it.each(['', 'not json', '{}', '{"status":"success"}'])(
    'does not report acceptance for malformed provider response %s', async (body) => {
      const transport = createUniSenderTransport(configured, async () => new Response(body));
      await expect(transport.send({ dedupeKey: 'key', to: 'a@example.com', subject: 's', html: '', text: '' }))
        .rejects.toThrow('invalid acceptance response');
    },
  );

  it('bounds long idempotency keys and keeps retries stable', async () => {
    const keys: string[] = [];
    const transport = createUniSenderTransport(configured, async (_url, init) => {
      keys.push(JSON.parse(String(init?.body)).message.idempotence_key);
      return Response.json({ status: 'success', job_id: 'job-1' });
    });
    const message = { dedupeKey: 'test:'.repeat(100), to: 'a@example.com', subject: 's', html: '', text: '' };
    await transport.send(message);
    await transport.send(message);
    expect(keys[0]).toHaveLength(64);
    expect(keys[1]).toBe(keys[0]);
  });

  it.each([undefined, ''])('uses provider defaults for %s settings and hashes the dedupe key', async (unset) => {
    let body: unknown;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      body = JSON.parse(String((init as RequestInit).body));
      return new Response(JSON.stringify({ status: 'success', job_id: 'job-1' }), { status: 200 });
    });
    const transport = createUniSenderTransport({ ...configured, apiUrl: unset, fromName: unset }, fetchFn);

    const result = await transport.send({
      dedupeKey: 'delivery-42',
      to: 'a@example.com',
      subject: 's',
      html: '<p>h</p>',
      text: 'h',
    });

    expect(result.providerMessageId).toBe('job-1');
    expect(body).toMatchObject({ message: { idempotence_key: createHash('sha256').update('delivery-42').digest('hex'), track_links: 0 } });
    expect(body).not.toHaveProperty('message.from_name');
    expect(fetchFn).toHaveBeenCalledWith(
      'https://go1.unisender.ru/ru/transactional/api/v1/email/send.json',
      expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'test-key' }) }),
    );
  });

  /**
   * The one thing about this deadline that must not drift: it has to expire before the caller stops
   * waiting. The other way round, a slow provider leaves the delivery recorded as sent and the event
   * that asked for it recorded as failed, and nothing reconciles the two.
   */
  it('gives the provider less time than the caller waits for an answer', () => {
    expect(PROVIDER_TIMEOUT_MS).toBeLessThan(RPC_TIMEOUT_MS);
    expect(PROVIDER_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('reports a rejected recipient as a failure', async () => {
    const transport = createUniSenderTransport(
      configured,
      async () =>
        new Response(JSON.stringify({ status: 'success', failed_emails: { 'a@example.com': 'invalid' } })),
    );

    await expect(
      transport.send({ dedupeKey: 'k', to: 'a@example.com', subject: 's', html: '', text: '' }),
    ).rejects.toThrow(/rejected the recipient/);
  });
});


describe('template variables', () => {
  it('collects placeholders from source and subject once', () => {
    expect(collectVariables('<a href="{{ resetUrl }}">{{email}}</a>', 'Hello {{email}}')).toEqual(['email', 'resetUrl']);
  });

  it('rejects undeclared subject variables as well as body variables', () => {
    expect(() => assertDeclaredVariables('<p>{{email}}</p>', '{{secret}}', ['email'])).toThrow(/secret/);
    expect(() => assertDeclaredVariables('<p>{{secret}}</p>', 'Subject', ['email'])).toThrow(TemplateRenderError);
    expect(() => assertDeclaredVariables('<p>{{email}}</p>', '{{email}}', ['email'])).not.toThrow();
  });

  it('escapes HTML values while keeping subject and plain text readable', () => {
    const variables = { name: '<b>Ada</b> & co' };
    expect(fillHtml('<p>{{name}}</p>', variables)).toBe('<p>&lt;b&gt;Ada&lt;/b&gt; &amp; co</p>');
    expect(fillText('Hello {{name}}', variables)).toBe('Hello <b>Ada</b> & co');
    expect(renderSubject('Hi {{name}}', variables)).toBe('Hi <b>Ada</b> & co');
    expect(escapeHtml('https://x.test/a?b=1&c=2')).toBe('https://x.test/a?b=1&amp;c=2');
  });

  it('retains missing values as placeholders', () => {
    expect(fillHtml('<a href="{{url}}">{{missing}}</a>', {})).toBe('<a href="{{url}}">{{missing}}</a>');
    expect(renderSubject('Hi {{name}}', {})).toBe('Hi {{name}}');
  });

  it.each(['javascript:alert(1)', 'data:text/html,hello', '//untrusted.test/a', 'java\nscript:alert(1)'])(
    'removes unsafe URL values after substitution: %s', (url) => {
      expect(fillHtml('<a href="{{url}}">Go</a><img src="{{url}}">', { url })).not.toMatch(/(?:href|src)=/);
    },
  );

  it('preserves a safe URL and encodes its ampersand once', () => {
    expect(fillHtml('<a href="{{url}}">Go</a>', { url: 'https://example.test/?a=1&b=2' }))
      .toBe('<a href="https://example.test/?a=1&amp;b=2">Go</a>');
  });
});

describe('HTML output', () => {
  it('preserves email head, styles and tables during sanitization', () => {
    const html = sanitizeHtml('<!doctype html><html><head><title>Email</title><style>.body{color:red}</style></head><body><table cellpadding="0" role="presentation"><tr><td style="color:red">Hello</td></tr></table></body></html>');
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<head>');
    expect(html).toContain('<style>.body{color:red}</style>');
    expect(html).toContain('cellpadding="0"');
    expect(html).toContain('style="color:red"');
    expect(htmlToText(html)).toBe('Hello');
  });

  it('removes scripts, frames, event handlers and entity-encoded unsafe links', () => {
    const html = sanitizeHtml('<p onclick="doSomething()">Visible</p><script>private script</script><iframe src="https://x.test"></iframe><a href="jav&#x61;script:alert(1)">Go</a>');
    expect(html).toBe('<p>Visible</p><a>Go</a>');
  });

  it('generates plain text without styles, hidden preheaders or HTML', () => {
    expect(htmlToText('<style>p{color:red}</style><p hidden>Hidden</p><h1>Title</h1><p>Body</p>'))
      .toBe('Title\n\nBody');
  });

  it('does not double-escape values in preview', async () => {
    const preview = await renderMessage(mjml('<p>{{url}}</p>'), 'Subject', { url: 'https://example.test/?a=1&b=2' });
    expect(preview.html).toContain('a=1&amp;b=2');
    expect(preview.html).not.toContain('&amp;amp;');
    expect(preview.text).toContain('a=1&b=2');
  });

  it('rejects a message without readable content', async () => {
    await expect(renderMessage(mjml('<script>only script</script>'), 'Subject'))
      .rejects.toThrow('no readable text');
  });

  it.each([
    ['https://x.test/reset?token=SECRET123&lang=en#form', 'https://x.test/reset?token=***&lang=en#form'],
    ['https://x.test/reset?lang=en&token=SECRET123&next=profile#form', 'https://x.test/reset?lang=en&token=***&next=profile#form'],
    ['<a href="https://x.test/reset?lang=en&amp;token=SECRET123&amp;next=profile#form">Reset</a>', '<a href="https://x.test/reset?lang=en&amp;token=***&amp;next=profile#form">Reset</a>'],
    ['https://x.test/reset?token=FIRST&amp;token=SECOND', 'https://x.test/reset?token=***&amp;token=***'],
  ])('redacts one-time tokens and preserves the surrounding URL: %s', (content, expected) => {
    expect(redactOneTimeTokens(content)).toBe(expected);
  });
});

describe('MJML rendering', () => {
  it('compiles responsive markup and fills recipient data', async () => {
    const rendered = await renderMessage(mjml('Hello {{name}}'), 'Hello {{name}}', { name: '<Ada> & co' });
    expect(rendered.html).toContain('<table');
    expect(rendered.html).toContain('&lt;Ada&gt; &amp; co');
    expect(rendered.text).toContain('Hello <Ada> & co');
    expect(rendered.subject).toBe('Hello <Ada> & co');
  });

  it('rejects invalid MJML instead of publishing partial output', async () => {
    await expect(renderMessage('<mjml><mj-body><mj-unknown /></mj-body></mjml>', 'Subject'))
      .rejects.toThrow(/Invalid MJML/);
  });

  it.each(['./part.mjml', '/tmp/private-file', 'https://example.test/part.mjml'])(
    'rejects includes before compilation: %s', async (path) => {
      await expect(renderMessage(`<mjml><mj-body><mj-include path="${path}" /></mj-body></mjml>`, 'Subject'))
        .rejects.toThrow('includes are not supported');
    },
  );

  it.each(['<p>Plain HTML</p>', '<!doctype html><html><body><p>Plain HTML</p></body></html>'])(
    'rejects raw HTML as a template source: %s', async (source) => {
      await expect(renderMessage(source, 'Subject')).rejects.toThrow(/Invalid MJML/);
    },
  );

  it('requires a text source and bounds its size', () => {
    const source = templateVersionSchema.shape.source;
    expect(source.safeParse({ type: 'doc' }).success).toBe(false);
    expect(source.safeParse('x'.repeat(1_000_001)).success).toBe(false);
  });
});

describe('seed templates', () => {
  it('declares every variable used by its source and subject', () => {
    for (const seed of SEED_TEMPLATES) {
      expect(() => assertDeclaredVariables(seed.source, seed.subject, seed.variables)).not.toThrow();
    }
  });

  it('compiles every initial Auth template', async () => {
    expect(SEED_TEMPLATES.map((seed) => seed.key).sort()).toEqual([
      'auth-confirm-email-change', 'auth-email-changed', 'auth-password-reset', 'auth-verify-email', 'auth-welcome',
    ]);
    for (const seed of SEED_TEMPLATES) {
      const compiled = await renderMessage(seed.source, seed.subject);
      expect(compiled.html).toContain('<table');
      expect(compiled.text.length).toBeGreaterThan(0);
    }
  });

  it('keeps placeholders when publishing, then fills only supplied values', async () => {
    const seed = SEED_TEMPLATES.find((entry) => entry.key === 'auth-password-reset')!;
    const compiled = await renderMessage(seed.source, seed.subject);
    expect(compiled.html).toContain('href="{{resetUrl}}"');
    expect(compiled.text).toContain('{{resetUrl}}');
    const html = fillHtml(compiled.html, { email: 'a@example.test', resetUrl: 'https://example.test/reset?token=secret' });
    expect(html).toContain('reset?token=secret');
    expect(html).not.toContain('{{');
    const preview = await renderMessage(seed.source, seed.subject, { email: 'a@example.test' });
    expect(preview.html).toContain('href="{{resetUrl}}"');
    expect(preview.text).toContain('a@example.test');
  });
});
