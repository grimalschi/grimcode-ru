import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import type { emailContract } from '@template/contracts';

/**
 * Client for this service's own admin API.
 *
 * The call goes through Gateway, which has already checked the session, the admin role and the
 * grant on Email. Operations that change something also carry a CSRF token this service issued.
 */
const BASE = '/admin/service/email';

// `previewVersion` renders without storing anything, so it needs no token.
const MUTATIONS = new Set([
  'createTemplate',
  'updateTemplate',
  'createDraft',
  'saveDraft',
  'publishDraft',
  'testSend',
  'uploadImage',
  'reindexSeedTemplates',
]);

const link = new RPCLink({
  url: `${window.location.origin}${BASE}/rpc`,
  fetch: (request, init) => fetch(request, { ...init, credentials: 'same-origin' }),
  headers: async (_options, path) => {
    if (!MUTATIONS.has(path.join('.'))) return {};
    return { 'x-csrf-token': await csrfToken() };
  },
});

let cached: Promise<string> | null = null;

async function csrfToken(): Promise<string> {
  cached ??= fetch(`${BASE}/csrf`, { credentials: 'same-origin' })
    .then((response) => {
      if (!response.ok) throw new Error('The CSRF token could not be obtained');
      return response.json() as Promise<{ token: string }>;
    })
    .then((body) => body.token)
    .catch((error: unknown) => {
      cached = null;
      throw error;
    });

  return cached;
}

export const api: ContractRouterClient<(typeof emailContract)['admin']> = createORPCClient(link);

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
