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
  'adminer',
] as const;

export type ServiceId = (typeof SERVICE_IDS)[number];

/** Services that expose an admin surface inside the central Admin shell. */
export const ADMIN_SERVICE_IDS = ['auth', 'users', 'notifications', 'email', 'adminer'] as const;

export type AdminServiceId = (typeof ADMIN_SERVICE_IDS)[number];

/**
 * Admin services an owner may hand to a regular administrator.
 * Adminer is deliberately absent: it is always owner-only and can never be granted.
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
export const localeSchema = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Expected a BCP 47 language tag such as "ru" or "en-US"');

/**
 * The language everything falls back to.
 *
 * It is one constant rather than a literal repeated across services, because the seed templates,
 * the profile default and the delivery fallback have to agree: a message that fell back to a
 * language nothing was seeded in would not be sent at all.
 */
export const DEFAULT_LOCALE = 'ru';

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
