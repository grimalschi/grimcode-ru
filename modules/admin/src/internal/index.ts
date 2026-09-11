import type { AdminApi } from '@template/contracts/modules/admin';
import type { ModuleContext } from '../context.js';
import { RPC_TIMEOUT_MS, withDeadlineOn } from '../rpc.js';
import { internalRouter } from './router.js';

/** Builds only the internal tRPC API; no HTTP application is created or imported. */
export function createInternalCaller(context: () => Promise<ModuleContext>): AdminApi {
  return withDeadlineOn(
    internalRouter.createCaller(context),
    'admin',
    RPC_TIMEOUT_MS,
  );
}
