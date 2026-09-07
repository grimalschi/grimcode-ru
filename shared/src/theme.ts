/**
 * Small same-origin `postMessage` protocol between the central Admin shell and a service admin
 * iframe.
 *
 * Both sides accept messages only from `window.location.origin`. Whatever the panel embeds has to
 * speak this, React or not: the third-party database browser did it from a PHP wrapper, and the
 * interface that replaces it will have to do the same.
 */
export const ADMIN_FRAME_MESSAGES = {
  /** shell → iframe: apply light, dark or system. */
  theme: 'template.admin.theme',
  /** shell → iframe: navigate to a service-relative path. */
  navigate: 'template.admin.navigate',
  /** iframe → shell: current service-relative path. */
  path: 'template.admin.path',
  /** iframe → shell: loading finished. */
  ready: 'template.admin.ready',
} as const;

export type ThemePreference = 'light' | 'dark' | 'system';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

export type AdminFrameMessage =
  | { type: typeof ADMIN_FRAME_MESSAGES.theme; theme: ThemePreference }
  | { type: typeof ADMIN_FRAME_MESSAGES.navigate; path: string }
  | { type: typeof ADMIN_FRAME_MESSAGES.path; path: string }
  | { type: typeof ADMIN_FRAME_MESSAGES.ready };

/** Structural subset of an element, so `shared` stays usable from Node services and browsers. */
export interface ThemeTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * Applies a theme to a document root.
 *
 * `system` removes the attribute so the stylesheet's `prefers-color-scheme` rules take over.
 */
export function applyTheme(root: ThemeTarget, theme: ThemePreference): void {
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/** Normalizes a service-relative path so shell and iframe always compare the same string. */
export function normalizeServicePath(path: string): string {
  if (path === '' || path === '/') return '/';
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
  return withLeadingSlash.replace(/\/{2,}/g, '/');
}
