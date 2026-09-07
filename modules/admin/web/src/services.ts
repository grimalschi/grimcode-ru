import type { AdminServiceId } from '@template/shared/vocabulary';

export interface AdminServiceEntry {
  id: AdminServiceId;
  label: string;
  /** Protected URL the iframe is pointed at. Gateway performs the same check on it directly. */
  embedHref: string;
  /**
   * Whether the shell keeps its URL in sync with the frame through the `postMessage` bridge. A
   * frame that navigates with ordinary server-rendered links has no path to report and only
   * receives the theme.
   */
  syncPath: boolean;
}

/**
 * The central Admin shell's own explicit list of admin services.
 *
 * It is declared here rather than derived from anything at runtime, exactly as Gateway declares its
 * own allowlist. `scripts/check-service-ids.mjs` reconciles the three declarations, so a service can
 * never be reachable through Gateway while being invisible here, or appear here without being
 * routable.
 *
 * What an administrator actually sees is filtered by the server: `admin.session` returns only the
 * services their role and grants allow. Hiding an entry is interface only — the direct URL passes
 * the very same Gateway check.
 */
export const ADMIN_SERVICES: readonly AdminServiceEntry[] = [
  { id: 'auth', label: 'Auth', embedHref: '/admin/embed/service/auth/', syncPath: true },
  { id: 'users', label: 'Users', embedHref: '/admin/embed/service/users/', syncPath: true },
  {
    id: 'notifications',
    label: 'Notifications',
    embedHref: '/admin/embed/service/notifications/',
    syncPath: true,
  },
  { id: 'email', label: 'Email', embedHref: '/admin/embed/service/email/', syncPath: true },
];

/**
 * The panel's own database area.
 *
 * Not in the list above: that list is the services of this template, each with its own admin. This
 * one shows every service's data at once, which is exactly why only the owner reaches it and why no
 * grant mentions it.
 *
 * Behind it is this template's own interface, a package of its own. It reports no path to the shell —
 * its view lives in its URL hash — so unlike a service admin it has nothing to keep in sync, which is
 * why it is a constant here rather than an entry in the list above.
 */
export const DATABASE_AREA = {
  label: 'База данных',
  embedHref: '/admin/embed/database/',
} as const;

export function findAdminService(id: string): AdminServiceEntry | undefined {
  return ADMIN_SERVICES.find((service) => service.id === id);
}
