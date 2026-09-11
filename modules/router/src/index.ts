import type { ModuleInstance } from '@template/contracts/module-instance';
import { createPublicFetch } from './public/index.js';
import type { RouterOptions } from './registry.js';

/** The only public listener: selects a surface and verifies every administrative request. */
export function createModule(options: RouterOptions) {
  return { id: 'router', publicFetch: createPublicFetch(options) } satisfies ModuleInstance;
}
