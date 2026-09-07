import { createTRPCClient, httpLink } from '@trpc/client';

import type { NotificationsAdminRouter } from '@template/notifications/contract';

/**
 * Client for this module's own admin API. Gateway has already checked the session, the role and the
 * grant on Notifications.
 *
 * No CSRF token here and no code to fetch one, because this surface changes nothing: an event is a
 * record of what happened, and a log that can be edited is not a record. Adding a mutation means
 * adding both halves by hand — `requireCsrf` on the procedure and a `headers` option here;
 * `modules/email/web/src/api.ts` is the working pattern.
 */
const BASE = '/admin/embed/service/notifications';

const link = httpLink({
  url: `${window.location.origin}${BASE}/rpc`,
  // Queries travel as POST too: bodies stay out of URLs, and out of the caches a GET invites.
  methodOverride: 'POST',
  fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' }),
});

export const api = createTRPCClient<NotificationsAdminRouter>({ links: [link] });

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
