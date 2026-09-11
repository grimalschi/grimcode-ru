import type { EmailApi } from '@template/contracts/modules/email';
import type { ModuleContext } from '../context.js';
import { RPC_TIMEOUT_MS, withDeadlineOn } from '../rpc.js';
import { internalRouter } from './router.js';

/** Internal delivery is a direct tRPC caller, with no administrative HTTP imports. */
export function createInternalCaller(context: () => Promise<ModuleContext>): EmailApi {
  return withDeadlineOn(internalRouter.createCaller(context), 'email', RPC_TIMEOUT_MS);
}
