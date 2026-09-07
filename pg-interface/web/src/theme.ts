/**
 * The theme, as the panel around this screen decides it.
 *
 * The panel holds this screen in a same-origin iframe and sends its theme over `postMessage`. Two
 * things are copied rather than imported, because this package imports nothing from the application
 * it is embedded in:
 *
 * - the message type, `template.admin.theme`. It is the host's, and renaming it on one side only
 *   would leave this screen light while the panel around it went dark;
 * - the convention: `light` and `dark` are written to `data-theme` on the root element, and `system`
 *   is the attribute's absence, so the stylesheet's own `prefers-color-scheme` rules take over.
 *
 * Messages are accepted from this window's own origin and nowhere else.
 */
const THEME_MESSAGE = 'template.admin.theme';

export type ThemePreference = 'light' | 'dark' | 'system';

function isPreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** What is actually on screen, which is what element-plus needs as a class. */
function resolved(preference: ThemePreference): 'light' | 'dark' {
  if (preference !== 'system') return preference;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function apply(preference: ThemePreference): void {
  const root = document.documentElement;

  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);

  // element-plus reads a class on the root; `data-theme` is the panel's convention. Both are set, so
  // the components and this screen's own styles agree.
  root.classList.toggle('dark', resolved(preference) === 'dark');
}

export function listenToPanel(): void {
  apply('system');

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;

    const message = event.data as { type?: unknown; theme?: unknown } | null;
    if (message?.type !== THEME_MESSAGE || !isPreference(message.theme)) return;

    apply(message.theme);
  });

  // `system` follows the machine while it is chosen, which the panel does not send again.
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if (!document.documentElement.hasAttribute('data-theme')) apply('system');
    });
}
