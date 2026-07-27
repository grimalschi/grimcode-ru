import { z } from 'zod';

/**
 * Canonical service ids of the template.
 *
 * Gateway keeps its own explicit allowlists and the central Admin shell keeps its own explicit
 * sidebar list. Neither of them derives ids from this constant at runtime — an automated test
 * reconciles all three declarations instead. See `services/gateway/src/registry.ts`,
 * `services/admin/web/src/services.ts` and `contracts/src/registry.test.ts`.
 */
export const SERVICE_IDS = [
  'site',
  'app',
  'admin',
  'auth',
  'users',
  'notifications',
  'email',
] as const;

export type ServiceId = (typeof SERVICE_IDS)[number];

/**
 * Services that expose an admin surface inside the central Admin shell.
 *
 * Every one of them is a service of this template with its own database, its own contract and its
 * own built admin. The database browser is not on this list: it belongs to the Admin panel, not to
 * a service — see `ADMIN_AREAS`.
 */
export const ADMIN_SERVICE_IDS = ['auth', 'users', 'notifications', 'email'] as const;

export type AdminServiceId = (typeof ADMIN_SERVICE_IDS)[number];

/**
 * What a request to the admin panel is asking for.
 *
 * `panel` is the shell and its own API. `service` is one service's admin. `database` is the panel's
 * own database browser — a window into every service's data at once, which is why it is a part of
 * the panel and never something an owner can hand out.
 */
export const ADMIN_AREAS = ['panel', 'service', 'database'] as const;

export type AdminArea = (typeof ADMIN_AREAS)[number];

/**
 * Admin services an owner may hand to a regular administrator.
 *
 * The same list as `ADMIN_SERVICE_IDS` today, and kept separate on purpose: a project that adds a
 * service admin only the owner should reach leaves it out of this one.
 */
export const ASSIGNABLE_SERVICE_IDS = ['auth', 'users', 'notifications', 'email'] as const;

export type AssignableServiceId = (typeof ASSIGNABLE_SERVICE_IDS)[number];

export const serviceIdSchema = z.enum(SERVICE_IDS);
export const adminServiceIdSchema = z.enum(ADMIN_SERVICE_IDS);
export const assignableServiceIdSchema = z.enum(ASSIGNABLE_SERVICE_IDS);

export const adminRoleSchema = z.enum(['owner', 'admin']);
export type AdminRole = z.infer<typeof adminRoleSchema>;

export const idSchema = z.uuid();
export const emailSchema = z.email().max(320).toLowerCase().trim();
export const isoDateTimeSchema = z.iso.datetime();

export const paginationInputSchema = z.object({
  query: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
});

export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().min(0),
    limit: z.number().int().min(1),
    offset: z.number().int().min(0),
  });
}

/**
 * Verified administrator context. Gateway builds it after a successful Admin authorization and
 * forwards it to the target service. Clients can never supply it: Gateway strips the incoming
 * headers of the same name before proxying.
 */
export const adminContextSchema = z.object({
  userId: idSchema,
  email: emailSchema,
  role: adminRoleSchema,
  requestId: z.string().min(1).max(200),
});

export type AdminContext = z.infer<typeof adminContextSchema>;

export const okSchema = z.object({ ok: z.literal(true) });
