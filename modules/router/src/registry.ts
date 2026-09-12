import type { ModuleInstance } from '@template/contracts/module-instance';
import type { AdminApi } from '@template/contracts/modules/admin';
import type { RouterEnv } from './env.js';

export type HttpHandler = NonNullable<ModuleInstance['publicFetch']>;
type AdminHandler = NonNullable<ModuleInstance['adminFetch']>;

/** Bound handlers supplied by composition, with separate public and administrative surfaces. */
export interface RouterOptions {
  env: RouterEnv;
  modules: { admin: AdminApi };
  publicFetches: Readonly<Record<string, HttpHandler> & { web: HttpHandler }>;
  adminFetches: Readonly<Record<string, AdminHandler> & { admin: AdminHandler }>;
}

export function hasModule(fetches: Readonly<Record<string, unknown>>, name: string): boolean {
  return name !== 'web' && name !== 'admin' && name !== 'router'
    && Object.hasOwn(fetches, name);
}
