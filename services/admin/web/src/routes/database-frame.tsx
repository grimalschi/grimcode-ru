import * as React from 'react';

import { useTheme } from '@/components/theme-provider';
import { Skeleton } from '@/components/ui/skeleton';
import { DATABASE_AREA } from '@/services';
import { ADMIN_FRAME_MESSAGES, type AdminFrameMessage } from '@template/shared/browser';

/**
 * The panel's database browser.
 *
 * A third-party application embedded same-origin, not a service admin: it shows every service's
 * data at once, which is why it is the owner's alone. Gateway checks the same thing whether it is
 * opened here or by its own URL.
 *
 * It navigates with ordinary server-rendered links, so unlike a service admin there is no path to
 * keep in sync — the shell only hands it the theme, and does that again on every load because each
 * of its own navigations is a fresh document.
 */
export function DatabaseFrame() {
  const frame = React.useRef<HTMLIFrameElement>(null);
  const { preference } = useTheme();
  const [loading, setLoading] = React.useState(true);

  const themeRef = React.useRef(preference);
  themeRef.current = preference;

  const post = React.useCallback((message: AdminFrameMessage) => {
    frame.current?.contentWindow?.postMessage(message, window.location.origin);
  }, []);

  React.useEffect(() => {
    const element = frame.current;
    if (!element) return;

    const handleLoad = () => {
      post({ type: ADMIN_FRAME_MESSAGES.theme, theme: themeRef.current });
      setLoading(false);
    };

    element.addEventListener('load', handleLoad);
    return () => element.removeEventListener('load', handleLoad);
  }, [post]);

  React.useEffect(() => {
    post({ type: ADMIN_FRAME_MESSAGES.theme, theme: preference });
  }, [post, preference]);

  return (
    <div className="relative h-full w-full">
      {loading ? (
        <div className="absolute inset-0 space-y-4 p-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : null}
      <iframe
        ref={frame}
        src={DATABASE_AREA.href}
        title={DATABASE_AREA.label}
        className="h-full w-full border-0"
        // Same-origin by design: the theme message and the session cookie both need it.
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
      />
    </div>
  );
}
