/** The journal is a history of delivery, not a second store of account recovery credentials. */
export function journalPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => {
    if (typeof value !== 'string') return [key, value];
    try {
      const url = new URL(value);
      if (!url.searchParams.has('token')) return [key, value];
      // set also removes duplicate token parameters. Never mutate the event sent to Email.
      url.searchParams.set('token', '***');
      return [key, url.toString()];
    } catch {
      return [key, value];
    }
  }));
}
