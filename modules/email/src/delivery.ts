import type { EmailRepository } from './repository.js';
import {
  fillHtml,
  fillText,
  redactOneTimeTokens,
  renderSubject,
  type VariableValue,
} from './render.js';
import type { Transport } from './transport.js';

export class UnknownTemplateError extends Error {
  constructor(templateKey: string) {
    super(`No published version of "${templateKey}"`);
    this.name = 'UnknownTemplateError';
  }
}

export interface SendInput {
  templateKey: string;
  to: string;
  variables: Record<string, VariableValue>;
  dedupeKey: string;
}

export interface SendResult {
  deliveryId: string;
  deduplicated: boolean;
  status: 'queued' | 'sent' | 'failed';
}

/** Sends the published HTML and text with recipient variables filled in. */
export async function sendTemplate(
  input: SendInput,
  deps: { repo: EmailRepository; transport: Transport },
): Promise<SendResult> {
  const existing = await deps.repo.findDeliveryByDedupeKey(input.dedupeKey);
  if (existing) {
    return { deliveryId: existing.id, deduplicated: true, status: existing.status };
  }

  const published = await deps.repo.findPublished(input.templateKey);

  if (!published || published.compiled_html === null || published.compiled_text === null) {
    throw new UnknownTemplateError(input.templateKey);
  }

  // The published content keeps `{{name}}` placeholders for the values that are only known per
  // recipient. Values are data, so they are escaped on the way into the HTML.
  const message = {
    subject: renderSubject(published.subject, input.variables),
    html: fillHtml(published.compiled_html, input.variables),
    text: fillText(published.compiled_text, input.variables),
  };

  // The snapshot is written before the transport runs, so nothing can leave the system without
  // being in the log — with one-time tokens taken out of it, because the log is a record and not a
  // second copy of the key.
  const { row, created } = await deps.repo.openDelivery({
    dedupeKey: input.dedupeKey,
    templateKey: input.templateKey,
    templateVersionId: published.id,
    recipientEmail: input.to,
    subject: redactOneTimeTokens(message.subject),
    html: redactOneTimeTokens(message.html),
    text: redactOneTimeTokens(message.text),
    transport: deps.transport.name,
  });

  if (!created) return { deliveryId: row.id, deduplicated: true, status: row.status };

  let result;
  try {
    result = await deps.transport.send({
      dedupeKey: input.dedupeKey,
      to: input.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await deps.repo.markFailed(row.id, reason);
    return { deliveryId: row.id, deduplicated: false, status: 'failed' };
  }
  // If recording acceptance fails, retain queued: the provider may already have sent the message.
  await deps.repo.markSent(row.id, result);
  return { deliveryId: row.id, deduplicated: false, status: 'sent' };
}
