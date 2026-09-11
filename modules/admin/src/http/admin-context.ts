import type { AdminContext } from '@template/contracts/modules/admin';
import { z } from 'zod';

/** The Router header convention, validated independently by this module. */
const adminContextSchema = z.object({
  userId: z.uuid(),
  email: z.email().max(320).toLowerCase().trim(),
  role: z.enum(['owner', 'admin']),
});

/**
 * Reads the verified context on the module side. Returns `null` when the headers are absent or
 * malformed, which for an admin surface always means "deny".
 */
export function readAdminContext(headers: Headers): AdminContext | null {
  const candidate = {
    userId: headers.get('x-template-admin-user-id') ?? undefined,
    email: headers.get('x-template-admin-email') ?? undefined,
    role: headers.get('x-template-admin-role') ?? undefined,
  };
  const parsed = adminContextSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
