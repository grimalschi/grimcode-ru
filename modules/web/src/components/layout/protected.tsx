import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import * as React from 'react';
import { toast } from 'sonner';

import { auth, messageOf } from '@/api';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { safeReturnPath } from '@/return-path';
import { useSession } from '@/session';

/**
 * Everything a signed-in user sees sits inside this frame.
 *
 * The guard exists for the flow, not for safety: Auth, Users and every other module check the
 * session again on each protected endpoint, so a revoked session fails there no matter what this
 * component still believes.
 */
export function Protected({ children }: { children: React.ReactNode }) {
  const { identity, loading } = useSession();
  const pathname = useRouterState({ select: (state) => state.location.href });
  const navigate = useNavigate();

  React.useEffect(() => {
    if (loading || identity) return;

    // The page that was being opened is remembered, but only if it is an internal application
    // route: an arbitrary redirect target must never survive a sign-in.
    const attempted = safeReturnPath(pathname);
    // The location can change before this layout unmounts. Do not redirect again from login
    // and overwrite the product destination that was just saved in its search parameters.
    if (!attempted) return;
    void navigate({ to: '/app/login', search: { next: attempted }, replace: true });
  }, [identity, loading, pathname, navigate]);

  // Nothing protected is rendered while the answer is unknown or negative, so an anonymous deep
  // link never flashes the interface it is not allowed to see.
  if (loading || !identity) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return <AppFrame>{children}</AppFrame>;
}

/** Grey at rest, darker under the pointer, dark and underlined for the open page; no bold, so nothing shifts. */
const NAV_LINK =
  "text-muted-foreground underline-offset-4 transition-colors hover:text-foreground [&.active]:text-foreground [&.active]:underline";

function AppFrame({ children }: { children: React.ReactNode }) {
  const { identity } = useSession();

  const logout = () => {
    // Signing out is a server operation: Auth invalidates the session, then the server clears the
    // cookie. Dropping the cookie in the browser would leave the session usable.
    auth.logout
      .mutate({})
      .then(() => window.location.assign('/app/login'))
      .catch((error: unknown) => toast.error(messageOf(error)));
  };

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-14 items-center justify-between gap-4 border-b px-4">
        <nav className="flex items-center gap-4 text-sm">
          {/* Exact: every application path starts with /app/, so without it Главная would stay lit everywhere. */}
          <Link
            to="/app/"
            activeOptions={{ exact: true }}
            className={NAV_LINK}
          >
            Главная
          </Link>
          <Link to="/app/settings" className={NAV_LINK}>
            Настройки
          </Link>
        </nav>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground hidden text-sm sm:inline">{identity?.email}</span>
          <ThemeToggle />
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={logout}>
            Выйти
          </Button>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
