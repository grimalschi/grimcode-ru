import type { ThemePreference } from '../theme';

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

export type ShellFrameMessage =
  | { type: typeof ADMIN_FRAME_MESSAGES.theme; theme: ThemePreference }
  | { type: typeof ADMIN_FRAME_MESSAGES.navigate; path: string };

export type ChildFrameMessage =
  | { type: typeof ADMIN_FRAME_MESSAGES.path; path: string }
  | { type: typeof ADMIN_FRAME_MESSAGES.ready };

/** Normalizes a module-relative path at this end of the frame protocol. */
export function normalizeModulePath(path: string): string {
  if (path === '' || path === '/') return '/';
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
  return withLeadingSlash.replace(/\/{2,}/g, '/');
}
