import { internalServiceUrl } from '@template/shared';

/**
 * Gateway's own explicit allowlists.
 *
 * A `:name` from the URL is never turned into a hostname: it is only ever used as a key of these
 * maps. An unknown name simply has no entry, so nothing is proxied.
 *
 * These lists are declared here on purpose instead of being derived from `contracts/` at runtime.
 * `scripts/check-service-ids.mjs` reconciles them with the central Admin shell's own list, so a
 * service can never be reachable through Gateway while being invisible in the shell, or the other
 * way round.
 */

/** `/service/:name/**` — no admin check. Securing these endpoints is the service's own job. */
export const PUBLIC_SERVICES = {
  auth: () => internalServiceUrl('auth'),
  users: () => internalServiceUrl('users'),
} as const satisfies Record<string, () => string>;

export type PublicServiceName = keyof typeof PUBLIC_SERVICES;

/**
 * `/admin/embed/services/:name/**` — reachable only after Admin allowed the request.
 */
export const ADMIN_SERVICES = {
  auth: () => internalServiceUrl('auth'),
  users: () => internalServiceUrl('users'),
  notifications: () => internalServiceUrl('notifications'),
  email: () => internalServiceUrl('email'),
} as const satisfies Record<string, () => string>;

export type AdminServiceName = keyof typeof ADMIN_SERVICES;

/**
 * The database browser behind the panel's own database area.
 *
 * It is not in `ADMIN_SERVICES` because it is not a service of this template: it is a third-party
 * application the panel embeds, reading every service's data at once. Gateway knows where it lives;
 * Admin decides who may reach it.
 */
export function databaseBrowserUrl(): string {
  return internalServiceUrl('adminer');
}

export function isPublicService(name: string): name is PublicServiceName {
  return Object.hasOwn(PUBLIC_SERVICES, name);
}

export function isAdminService(name: string): name is AdminServiceName {
  return Object.hasOwn(ADMIN_SERVICES, name);
}

export function publicServiceUrl(name: PublicServiceName): string {
  return PUBLIC_SERVICES[name]();
}

export function adminServiceUrl(name: AdminServiceName): string {
  return ADMIN_SERVICES[name]();
}
