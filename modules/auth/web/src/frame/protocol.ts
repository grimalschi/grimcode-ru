/**
 * This module's half of the same-origin Admin frame protocol. The message names are a wire
 * convention; the shell and each iframe own their implementations and exchange no runtime code.
 */
export const ADMIN_FRAME_MESSAGES = {
  theme: 'template.admin.theme',
  navigate: 'template.admin.navigate',
  path: 'template.admin.path',
  ready: 'template.admin.ready',
} as const;

/** Normalizes a module-relative path at this end of the frame protocol. */
export function normalizeModulePath(path: string): string {
  if (path === '' || path === '/') return '/';
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
  return withLeadingSlash.replace(/\/{2,}/g, '/');
}
