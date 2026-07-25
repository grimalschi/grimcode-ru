import type { AdminServiceId } from '@template/contracts';

export interface AdminServiceEntry {
  id: AdminServiceId;
  /** Label shown in the sidebar. */
  label: string;
  /** Protected URL the iframe is pointed at. Gateway performs the same check on it directly. */
  href: string;
  /**
   * Whether the shell keeps its URL in sync with the frame through the `postMessage` bridge.
   * Adminer navigates with ordinary server-rendered links and only receives the theme.
   */
  syncPath: boolean;
}

/**
 * The central Admin shell's own explicit list of admin services.
 *
 * It is declared here rather than derived from `contracts/` or from Gateway at runtime, exactly as
 * Gateway declares its own allowlist. `scripts/check-service-ids.mjs` reconciles the three
 * declarations, so a service can never be reachable through Gateway while being invisible here, or
 * appear here without being routable.
 *
 * What an administrator actually sees is filtered by the server: `admin.session` returns only the
 * services their role and grants allow. Hiding an entry is interface only — the direct URL passes
 * the very same Gateway check.
 */
export const ADMIN_SERVICES: readonly AdminServiceEntry[] = [
  { id: 'auth', label: 'Auth', href: '/admin/service/auth/', syncPath: true },
  { id: 'users', label: 'Users', href: '/admin/service/users/', syncPath: true },
  {
    id: 'notifications',
    label: 'Notifications',
    href: '/admin/service/notifications/',
    syncPath: true,
  },
  { id: 'email', label: 'Email', href: '/admin/service/email/', syncPath: true },
  { id: 'adminer', label: 'Database', href: '/admin/service/adminer/', syncPath: false },
];

export function findAdminService(id: string): AdminServiceEntry | undefined {
  return ADMIN_SERVICES.find((service) => service.id === id);
}
