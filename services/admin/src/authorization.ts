import {
  ADMIN_SERVICE_IDS,
  type AdminServiceId,
  type AuthorizationResult,
  type authInternalContract,
  type ContractRouterClient,
} from '@template/contracts';
import type { Logger } from '@template/shared';

import type { AdminRepository } from './repository.js';

export type AuthClient = ContractRouterClient<typeof authInternalContract>;

export interface AuthorizeDeps {
  repo: AdminRepository;
  auth: AuthClient;
  logger: Logger;
}

/** Adminer is owner-only and can never be handed to a regular administrator. */
const OWNER_ONLY_SERVICES: readonly AdminServiceId[] = ['adminer'];

/**
 * The single decision Gateway asks for on every `/admin/**` request.
 *
 * Gateway computes nothing itself and caches nothing, so a changed role or grant takes effect on
 * the very next request. Everything this function needs about the current user comes from Auth
 * through its contract; Admin never reads the Auth database.
 */
export async function authorize(
  input: { sessionToken: string | null; service: AdminServiceId | null },
  deps: AuthorizeDeps,
): Promise<AuthorizationResult> {
  if (input.service !== null && !ADMIN_SERVICE_IDS.includes(input.service)) {
    return { state: 'denied', reason: 'unknown-service' };
  }

  if (!input.sessionToken) return { state: 'denied', reason: 'no-session' };

  const { identity } = await deps.auth.resolveSession({ sessionToken: input.sessionToken });
  if (!identity) return { state: 'denied', reason: 'no-session' };

  if (await deps.repo.isRegistryEmpty()) {
    const bootstrapped = await bootstrapFirstOwner(deps);
    if (bootstrapped === 'awaiting-first-user') return { state: 'awaiting-first-user' };
  }

  const administrator = await deps.repo.findByUserId(identity.id);
  // Ownership follows registration order in Auth, not who opened the admin panel first. If someone
  // else opened it, the first Auth user still became owner and this request is refused.
  if (!administrator) return { state: 'denied', reason: 'not-an-administrator' };
  if (!administrator.enabled) return { state: 'denied', reason: 'disabled' };

  const allowed = {
    state: 'allowed',
    userId: administrator.user_id,
    email: administrator.email,
    role: administrator.role,
  } as const;

  // Central Admin itself is open to any enabled administrator; the sidebar then shows only what
  // their role and grants allow.
  if (input.service === null) return allowed;

  if (OWNER_ONLY_SERVICES.includes(input.service)) {
    return administrator.role === 'owner' ? allowed : { state: 'denied', reason: 'owner-only' };
  }

  if (administrator.role === 'owner') return allowed;

  const grants = administrator.grants ?? [];
  return grants.includes(input.service) ? allowed : { state: 'denied', reason: 'no-grant' };
}

/**
 * Promotes the earliest registered Auth identity to owner.
 *
 * Idempotent and safe under concurrency: the insert is conditional and only the request that
 * really created the row writes the audit entry. Once any administrator exists the bootstrap stops
 * being attempted at all.
 */
async function bootstrapFirstOwner(deps: AuthorizeDeps): Promise<'done' | 'awaiting-first-user'> {
  const { identity: first } = await deps.auth.getFirstIdentity({});
  if (!first) return 'awaiting-first-user';

  const { created } = await deps.repo.bootstrapOwner(first.id, first.email);
  if (created) deps.logger.info('first owner bootstrapped', { userId: first.id });
  return 'done';
}

/** Admin services this administrator may open, used to build the shell's sidebar. */
export function visibleServices(
  role: 'owner' | 'admin',
  grants: readonly string[],
): AdminServiceId[] {
  if (role === 'owner') return [...ADMIN_SERVICE_IDS];
  return ADMIN_SERVICE_IDS.filter(
    (service) => !OWNER_ONLY_SERVICES.includes(service) && grants.includes(service),
  );
}
