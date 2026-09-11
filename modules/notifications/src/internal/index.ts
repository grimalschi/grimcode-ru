import type { NotificationsApi } from '@template/contracts/modules/notifications';
import { RPC_TIMEOUT_MS, withDeadlineOn } from '../rpc.js';
import { internalRouter, type InternalContext } from './router.js';

/** Internal event acceptance never constructs or imports an HTTP surface. */
export function createInternalCaller(context: () => Promise<InternalContext>): NotificationsApi {
  return withDeadlineOn(internalRouter.createCaller(context), 'notifications', RPC_TIMEOUT_MS);
}
