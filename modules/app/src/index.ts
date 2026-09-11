import type { ModuleInstance } from '@template/contracts/module-instance';
import { createPublicFetch } from './public/index.js';

/**
 * The user-facing application.
 *
 * It has no database of its own: identity and sessions come from Auth, the product profile from
 * Users, and every protected call is checked by the module that owns the data.
 * Its public entry owns serving the built interface.
 *
 * It takes nothing: no state, no neighbour and no settings, so the composer calls it with no
 * arguments at all.
 */
export function createModule() {
  return { id: 'app', publicFetch: createPublicFetch() } satisfies ModuleInstance;
}
