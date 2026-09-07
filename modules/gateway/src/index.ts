import type { AdminInternalCaller } from '@template/admin/contract';
import { createServiceApp, type ServiceApp } from '@template/shared';

import { routeRequest } from './router.js';
import type { GatewayTargets } from './registry.js';

export type { GatewayTargets } from './registry.js';

export interface GatewayDeps {
  /** Every module Gateway may route to, built and handed over by the composer. */
  targets: GatewayTargets;
  /** Asks Admin for the decision; `targets.admin` is where an allowed request then goes. */
  callAdmin: (call: { requestId: string }) => AdminInternalCaller;
}

/**
 * Gateway is the entrance for traffic: the composer mounts it, and only it, on the public
 * listener, so every request from outside arrives here before it reaches anything else.
 *
 * It is not the entrance to the *program* — that is the composer. The composer needs to know every
 * module; Gateway holds the access policy, and the two together would be the widest permission in
 * the repository handed to the narrowest job.
 */
export function createApp(deps: GatewayDeps): ServiceApp {
  const app = createServiceApp('gateway');

  app.all('*', (c) =>
    routeRequest(c.req.raw, c.get('requestId'), deps.targets, deps.callAdmin),
  );

  return app;
}
