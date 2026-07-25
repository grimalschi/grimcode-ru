import { adminContextSchema, type AdminContext } from '@template/contracts';

/**
 * Headers carrying the administrator context Gateway verified.
 *
 * A browser must never be able to forge them: Gateway removes every one of these headers from the
 * incoming request before it decides anything, and writes them again only after Admin allowed the
 * request. Services trust them precisely because only Gateway can reach them.
 */
export const ADMIN_CONTEXT_HEADERS = [
  'x-template-admin-user-id',
  'x-template-admin-email',
  'x-template-admin-role',
  'x-template-request-id',
] as const;

export const REQUEST_ID_HEADER = 'x-template-request-id';

/** Removes every control header a client might have sent. Always called before authorization. */
export function stripAdminContextHeaders(headers: Headers): void {
  for (const header of ADMIN_CONTEXT_HEADERS) headers.delete(header);
}

export function applyAdminContext(headers: Headers, context: AdminContext): void {
  headers.set('x-template-admin-user-id', context.userId);
  headers.set('x-template-admin-email', context.email);
  headers.set('x-template-admin-role', context.role);
  headers.set(REQUEST_ID_HEADER, context.requestId);
}

/**
 * Reads the verified context on the service side. Returns `null` when the headers are absent or
 * malformed, which for an admin surface always means "deny".
 */
export function readAdminContext(headers: Headers): AdminContext | null {
  const candidate = {
    userId: headers.get('x-template-admin-user-id') ?? undefined,
    email: headers.get('x-template-admin-email') ?? undefined,
    role: headers.get('x-template-admin-role') ?? undefined,
    requestId: headers.get(REQUEST_ID_HEADER) ?? undefined,
  };
  const parsed = adminContextSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export type { AdminContext };
