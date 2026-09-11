import { createHash } from 'node:crypto';
import { RPC_TIMEOUT_MS } from './rpc.js';

// Leave time to record the provider response before the internal caller deadline.
export const PROVIDER_TIMEOUT_MS = RPC_TIMEOUT_MS - 2_000;

export type TransportName = 'log' | 'unisender';

/** Where UniSender Go answers when a deployment does not name another address. */
const UNISENDER_API_URL = 'https://go1.unisender.ru/ru/transactional/api/v1';

export interface MailSettings {
  /** Defaults to log when empty or unset. */
  provider?: string;
  apiKey?: string;
  /** Empty or unset means the provider's own address above. */
  apiUrl?: string;
  /** UniSender Go will not send without a sender. */
  fromAddress?: string;
  fromName?: string;
}

export interface OutboundMessage {
  /** Stable delivery identity; the transport maps it to a provider-compatible key. */
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

/** Local delivery is recorded in the journal by the caller. */
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

export function createUniSenderTransport(
  settings: MailSettings,
  fetchFn: typeof fetch = fetch,
): Transport {
  const { apiKey = '', fromAddress: fromEmail = '', fromName } = settings;
  const apiUrl = (settings.apiUrl || UNISENDER_API_URL).replace(/\/+$/, '');

  const missing = [
    ...(apiKey.trim() === '' ? ['UNISENDER_GO_API_KEY'] : []),
    ...(fromEmail.trim() === '' ? ['EMAIL_FROM_ADDRESS'] : []),
  ];
  if (missing.length > 0) throw new TransportConfigurationError(missing);
  if (!/^https?:$/.test(new URL(apiUrl).protocol)) throw new Error('Invalid UniSender Go API URL');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) throw new Error('Invalid EMAIL_FROM_ADDRESS');

  return {
    name: 'unisender',
    async send(message) {
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
            ...(fromName ? { from_name: fromName } : {}),
            track_links: 0,
            track_read: 0,
            idempotence_key: createHash('sha256').update(message.dedupeKey).digest('hex'),
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

      const messageId = field(payload, 'job_id') ?? field(payload, 'message_id');
      if (field(payload, 'status') !== 'success' || !messageId) {
        throw new Error('UniSender Go returned an invalid acceptance response');
      }

      return {
        providerMessageId: messageId,
        providerStatus: 'accepted',
      };
    },
  };
}

/** Which transport the settings ask for. The choice stays here; the values come from outside. */
export function createTransport(settings: MailSettings, fetchFn: typeof fetch = fetch): Transport {
  switch (settings.provider || 'log') {
    case 'unisender': return createUniSenderTransport(settings, fetchFn);
    case 'log': return createLogTransport();
    default: throw new Error(`Unknown EMAIL_PROVIDER: ${settings.provider}`);
  }
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
