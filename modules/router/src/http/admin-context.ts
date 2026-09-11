import type { AdminContext } from '@template/contracts/modules/admin';

/**
 * Headers carrying the administrator context Router verified.
 *
 * A browser must never be able to forge them: Router removes every one of these headers from the
 * incoming request before it decides anything, and writes them again only after Admin allowed the
 * request. Modules trust them precisely because only Router can reach them.
 */
export const ADMIN_CONTEXT_HEADERS = [
  'x-template-admin-user-id',
  'x-template-admin-email',
  'x-template-admin-role',
] as const;

/** Removes every control header a client might have sent. Always called before authorization. */
export function stripAdminContextHeaders(headers: Headers): void {
  for (const header of ADMIN_CONTEXT_HEADERS) headers.delete(header);
}

export function applyAdminContext(headers: Headers, context: AdminContext): void {
  headers.set('x-template-admin-user-id', context.userId);
  headers.set('x-template-admin-email', context.email);
  headers.set('x-template-admin-role', context.role);
}
