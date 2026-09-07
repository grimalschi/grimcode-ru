import type { FetchLike } from '@template/shared';

import type { ProxyTarget } from './proxy.js';

/**
 * Gateway's own explicit allowlists. A `:name` from the URL is only ever a key of these maps, so an
 * unknown name has no entry and nothing is routed. `check-service-ids.mjs` reconciles them with the
 * Admin shell's list and reads them as text — they have to stay literals with one key per line.
 */

/** `/service/:name/**` — no admin check. Securing these endpoints is the module's own job. */
export const PUBLIC_SERVICES = {
  auth: true,
  users: true,
} as const satisfies Record<string, true>;

export type PublicServiceName = keyof typeof PUBLIC_SERVICES;

/**
 * `/admin/embed/service/:name/**` — reachable only after Admin allowed the request.
 */
export const ADMIN_SERVICES = {
  auth: true,
  users: true,
  notifications: true,
  email: true,
} as const satisfies Record<string, true>;

export type AdminServiceName = keyof typeof ADMIN_SERVICES;

/**
 * Everything Gateway can route to. Every target is an application in this process, and Gateway
 * forwards the request to it unchanged — routing goes by path, so who answers is the only thing that
 * ever changes. `admin` is narrower on purpose: Gateway calls it on every `/admin/**` request to ask
 * whether it is allowed at all.
 *
 * `database` is not in either allowlist above and is named on its own here: it is not a module of this
 * template but the panel's own section, reading every module's data at once — which is why only the
 * owner reaches it, why no grant can name it, and why it has no `:name` a URL could ask for.
 */
export interface GatewayTargets extends Record<AdminServiceName | PublicServiceName, ProxyTarget> {
  site: ProxyTarget;
  app: ProxyTarget;
  admin: FetchLike;
  database: ProxyTarget;
}

export function isPublicService(name: string): name is PublicServiceName {
  return Object.hasOwn(PUBLIC_SERVICES, name);
}

export function isAdminService(name: string): name is AdminServiceName {
  return Object.hasOwn(ADMIN_SERVICES, name);
}
