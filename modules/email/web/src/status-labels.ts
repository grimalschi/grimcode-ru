/**
 * What a person reads for each stored status. The stored values stay as they are; only the screen
 * speaks Russian.
 */
export const VERSION_STATUS_LABEL = {
  draft: 'Черновик',
  published: 'Опубликована',
  archived: 'В архиве',
} as const;

export const DELIVERY_STATUS_LABEL = {
  queued: 'В очереди',
  sent: 'Отправлено',
  failed: 'Ошибка',
} as const;

/** `log` keeps the letter here and sends nothing; a provider's own name is left as it is. */
export const TRANSPORT_LABEL: Record<string, string> = {
  log: 'локально, без отправки',
  unisender: 'UniSender',
};
