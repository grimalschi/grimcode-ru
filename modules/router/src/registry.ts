import type { ModuleInstance } from '@template/contracts/module-instance';
import type { AdminApi } from '@template/contracts/modules/admin';
import type { RouterEnv } from './env.js';

export type HttpHandler = NonNullable<ModuleInstance['publicFetch']>;

/** Bound handlers supplied by composition, with separate public and administrative surfaces. */
export interface RouterOptions {
  env: RouterEnv;
  modules: { admin: AdminApi };
  publicFetches: Readonly<Record<string, HttpHandler> & { site: HttpHandler; app: HttpHandler }>;
  adminFetches: Readonly<Record<string, HttpHandler> & { admin: HttpHandler }>;
}

export function hasModule(fetches: Readonly<Record<string, HttpHandler>>, name: string): boolean {
  return name !== 'site' && name !== 'app' && name !== 'admin' && name !== 'router'
    && Object.hasOwn(fetches, name);
}
