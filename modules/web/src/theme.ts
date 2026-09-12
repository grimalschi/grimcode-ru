/** This module owns its theme preference. */
export type ThemePreference = 'light' | 'dark' | 'system';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** Apply the existing product preference before paint without changing public pages. */
export const themeScript = `(() => {
  if (!/^\\/app(?:\\/|$)/.test(window.location.pathname)) return;
  try {
    const stored = localStorage.getItem('template.app.theme') ?? 'system';
    const dark = stored === 'dark' ||
      (stored === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  } catch {
    // Storage may be unavailable; the default palette still works.
  }
})();`;
