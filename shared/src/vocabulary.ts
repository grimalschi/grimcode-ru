/**
 * The words every part of this template shares, and the only file a browser bundle may take a
 * runtime value from.
 *
 * The primitives every schema is built out of, and the vocabulary the modules hold in common; a
 * module's own shapes belong in its own `schemas.ts`.
 *
 * **It imports `zod` and nothing else, and there is a check behind that.** Browser bundles read this
 * file, so one import of `env.ts` and `process.env` follows it into a page, where it does not exist.
 */

import { z } from 'zod';

/**
 * Services that expose an admin surface inside the central Admin shell. The database browser is not
 * here: it belongs to the panel and not to a service — see `adminTargetSchema`.
 */
export const ADMIN_SERVICE_IDS = ['auth', 'users', 'notifications', 'email'] as const;

export type AdminServiceId = (typeof ADMIN_SERVICE_IDS)[number];

/**
 * What a request to the admin panel is asking for. `database` is the panel's own browser — a window
 * into every service's data at once, which is why it is never something an owner can hand out.
 * Gateway works the target out from the URL and Admin decides who may reach it, and both read this.
 */
export const adminTargetSchema = z.discriminatedUnion('area', [
  z.object({ area: z.literal('panel') }),
  z.object({ area: z.literal('service'), service: z.enum(ADMIN_SERVICE_IDS) }),
  z.object({ area: z.literal('database') }),
]);

export type AdminTarget = z.infer<typeof adminTargetSchema>;

/**
 * Admin services an owner may hand to a regular administrator. The same list as `ADMIN_SERVICE_IDS`
 * today, and separate on purpose: a service admin only the owner should reach is left out of this.
 */
export const ASSIGNABLE_SERVICE_IDS = ['auth', 'users', 'notifications', 'email'] as const;

export type AssignableServiceId = (typeof ASSIGNABLE_SERVICE_IDS)[number];

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

/**
 * Notifications accepts only these known typed events; anything else is rejected before it can
 * reach Email.
 *
 * The list stays here rather than in the module because the admin screen renders a filter from it —
 * a **browser** needs the array at runtime, and a module's door hands over types only.
 */
export const NOTIFICATION_EVENT_TYPES = [
  'auth.user.registered',
  'auth.email.verification_requested',
  'auth.password.reset_requested',
  'auth.email.change_requested',
  'auth.email.changed',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export const notificationEventTypeSchema = z.enum(NOTIFICATION_EVENT_TYPES);
