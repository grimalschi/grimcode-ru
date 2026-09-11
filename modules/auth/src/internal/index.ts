import type { AuthApi } from '@template/contracts/modules/auth';

import type { AuthRepository } from '../repository.js';
import { internalRouter } from './router.js';

/** The caller resolves only after the operation completes, including its transaction. */
export function createInternalCaller(
  repository: () => Promise<AuthRepository>,
): AuthApi {
  return internalRouter.createCaller(async () => ({ repo: await repository() }));
}
