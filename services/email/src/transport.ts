import { optionalEnv, type Logger } from '@template/shared';

export type TransportName = 'log' | 'unisender';

export interface OutboundMessage {
  /** Reused as the provider's idempotency key, so a retry cannot send twice. */
  dedupeKey: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface TransportResult {
  providerMessageId: string | null;
  providerStatus: string | null;
}

export interface Transport {
  name: TransportName;
  send(message: OutboundMessage): Promise<TransportResult>;
}

/**
 * Local transport: messages are written to the delivery log and never leave the machine.
 *
 * The full HTML and text are already stored as an immutable snapshot by the caller, so nothing is
 * lost by not sending.
 */
export function createLogTransport(logger: Logger): Transport {
  return {
    name: 'log',
    async send(message) {
      logger.info('email captured by the local log transport', {
        to: message.to,
        subject: message.subject,
        dedupeKey: message.dedupeKey,
        htmlBytes: message.html.length,
        textBytes: message.text.length,
      });
      return { providerMessageId: null, providerStatus: 'logged' };
    },
  };
}

export class TransportConfigurationError extends Error {
  constructor(missing: readonly string[]) {
    super(`UniSender Go is not configured: ${missing.join(', ')} missing`);
    this.name = 'TransportConfigurationError';
  }
}

/**
 * UniSender Go — the single ready production transport of the template.
 *
 * A concrete project adds another provider by implementing this small interface, which is an
 * ordinary code change rather than a configuration matrix.
 */
export function createUniSenderTransport(fetchFn: typeof fetch = fetch): Transport {
  const apiKey = optionalEnv('UNISENDER_GO_API_KEY', '');
  const apiUrl = optionalEnv(
    'UNISENDER_GO_API_URL',
    'https://go1.unisender.ru/ru/transactional/api/v1',
  ).replace(/\/+$/, '');
  const fromEmail = optionalEnv('EMAIL_FROM_ADDRESS', '');
  const fromName = optionalEnv('EMAIL_FROM_NAME', '');

  const missing = [
    ...(apiKey === '' ? ['UNISENDER_GO_API_KEY'] : []),
    ...(fromEmail === '' ? ['EMAIL_FROM_ADDRESS'] : []),
  ];

  return {
    name: 'unisender',
    async send(message) {
      if (missing.length > 0) throw new TransportConfigurationError(missing);

      const response = await fetchFn(`${apiUrl}/email/send.json`, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          message: {
            recipients: [{ email: message.to }],
            body: { html: message.html, plaintext: message.text },
            subject: message.subject,
            from_email: fromEmail,
            ...(fromName === '' ? {} : { from_name: fromName }),
            track_links: 0,
            track_read: 0,
            idempotence_key: message.dedupeKey,
          },
        }),
      });

      const payload = await readJson(response);

      if (!response.ok || field(payload, 'status') === 'error') {
        throw new Error(
          `UniSender Go rejected the message (${response.status}): ` +
            (field(payload, 'message') ?? field(payload, 'error') ?? response.statusText),
        );
      }

      const failed = asObject(payload)?.failed_emails;
      if (failed && typeof failed === 'object' && Object.keys(failed).length > 0) {
        throw new Error(`UniSender Go rejected the recipient: ${JSON.stringify(failed)}`);
      }

      return {
        providerMessageId: field(payload, 'job_id') ?? field(payload, 'message_id'),
        providerStatus: 'accepted',
      };
    },
  };
}

export function createTransport(logger: Logger, fetchFn: typeof fetch = fetch): Transport {
  return optionalEnv('EMAIL_PROVIDER', 'log') === 'unisender'
    ? createUniSenderTransport(fetchFn)
    : createLogTransport(logger);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function field(value: unknown, key: string): string | null {
  const found = asObject(value)?.[key];
  return typeof found === 'string' && found.trim() !== '' ? found.trim() : null;
}

async function readJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (body === '') return null;
  try {
    return JSON.parse(body);
  } catch {
    return { message: body.slice(0, 500) };
  }
}
