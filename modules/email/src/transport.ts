import { RPC_TIMEOUT_MS } from '@template/shared';

/**
 * Deadline on the one outbound call this module makes.
 *
 * Derived rather than written out, because what matters is that it stays **below** the budget the
 * caller waits with: Notifications gives up at `RPC_TIMEOUT_MS`, and a provider answering after that
 * would leave the delivery recorded as sent while the event that asked for it is recorded as failed —
 * with nothing able to reconcile the two afterwards. The margin covers the rest of the request:
 * filling the values in, two queries and the log write.
 */
export const PROVIDER_TIMEOUT_MS = RPC_TIMEOUT_MS - 2_000;

export type TransportName = 'log' | 'unisender';

/** Where UniSender Go answers when a deployment does not name another address. */
const UNISENDER_API_URL = 'https://go1.unisender.ru/ru/transactional/api/v1';

/**
 * Everything the mail transport needs, handed over by the composer.
 *
 * The module does not read the environment: the composer does, and hands these over on `c.env`. That is
 * the rule for every module, and the lint rules enforce it.
 *
 * The values arrive as they were written, unset ones as empty strings, and what empty means is
 * decided here — one per field, and each on purpose. `provider` is not narrowed to `TransportName`
 * for the same reason: it comes from a person editing a file, and anything that is not `unisender`
 * is the log transport, so a misspelt provider records messages instead of mailing them.
 */
export interface MailSettings {
  /** Anything but `unisender`, empty included, selects the log transport. */
  provider: string;
  apiKey: string;
  /** Empty means the provider's own address above. */
  apiUrl: string;
  /** Empty is not a default but a refusal: UniSender Go will not send without a sender. */
  fromAddress: string;
  fromName: string;
}

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
 * Local transport: the message goes nowhere and never leaves the machine.
 *
 * It does not need to do anything, and that is the point — the caller has already stored the full
 * HTML and text as an immutable snapshot in the delivery journal, which is where a local message is
 * read from. The name stays `log` because the journal is what `EMAIL_PROVIDER=log` selects.
 */
export function createLogTransport(): Transport {
  return {
    name: 'log',
    async send(_message) {
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
export function createUniSenderTransport(
  settings: MailSettings,
  fetchFn: typeof fetch = fetch,
): Transport {
  const { apiKey, fromAddress: fromEmail, fromName } = settings;
  const apiUrl = (settings.apiUrl === '' ? UNISENDER_API_URL : settings.apiUrl).replace(/\/+$/, '');

  // The message names the variables rather than the fields, though this module reads neither: what
  // it is asking for is an edit to a deployment's environment, and that is where the names are.
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
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
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

/** Which transport the settings ask for. The choice stays here; the values come from outside. */
export function createTransport(settings: MailSettings, fetchFn: typeof fetch = fetch): Transport {
  return settings.provider === 'unisender'
    ? createUniSenderTransport(settings, fetchFn)
    : createLogTransport();
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
