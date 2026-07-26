import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useRouterState,
} from '@tanstack/react-router';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';

import { auth, messageOf } from '@/api';
import { AdminThemeProvider } from '@/components/theme-provider';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import {
  LoginScreen,
  RegisterScreen,
  RequestResetScreen,
  ResetPasswordScreen,
  VerifyEmailScreen,
} from '@/routes/auth-screens';
import { DashboardScreen } from '@/routes/dashboard';
import { OnboardingScreen } from '@/routes/onboarding';
import { SettingsScreen } from '@/routes/settings';
import { safeReturnPath } from '@/return-path';
import { SessionProvider, useSession } from '@/session';

import '@/styles.css';

function Root() {
  return (
    <SessionProvider>
      <Outlet />
      <Toaster position="bottom-right" />
    </SessionProvider>
  );
}

/**
 * Everything a signed-in user sees sits inside this frame.
 *
 * The guard exists for the flow, not for safety: Auth, Users and every other service check the
 * session again on each protected endpoint, so a revoked session fails there no matter what this
 * component still believes.
 */
function Protected({ children }: { children: React.ReactNode }) {
  const { identity, loading } = useSession();
  const pathname = useRouterState({ select: (state) => state.location.href });

  React.useEffect(() => {
    if (loading || identity) return;

    // The page that was being opened is remembered, but only if it is an internal application
    // route: an arbitrary redirect target must never survive a sign-in.
    const attempted = safeReturnPath(`/app${pathname}`);
    const query = attempted ? `?next=${encodeURIComponent(attempted)}` : '';
    window.location.replace(`/app/login${query}`);
  }, [identity, loading, pathname]);

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

function AppFrame({ children }: { children: React.ReactNode }) {
  const { identity } = useSession();

  const logout = () => {
    // Signing out is a server operation: Auth invalidates the session, then the server clears the
    // cookie. Dropping the cookie in the browser would leave the session usable.
    auth
      .logout({})
      .then(() => window.location.assign('/app/login'))
      .catch((error: unknown) => toast.error(messageOf(error)));
  };

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-14 items-center justify-between gap-4 border-b px-4">
        <nav className="flex items-center gap-4 text-sm">
          <Link to="/" className="font-medium [&.active]:underline underline-offset-4">
            Home
          </Link>
          <Link to="/settings" className="[&.active]:underline underline-offset-4">
            Settings
          </Link>
        </nav>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground hidden text-sm sm:inline">{identity?.email}</span>
          <ThemeToggle />
          <Button variant="ghost" size="sm" onClick={logout}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}

const rootRoute = createRootRoute({ component: Root });

const tokenSearch = (search: Record<string, unknown>) => ({
  token: typeof search.token === 'string' ? search.token : undefined,
});

const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginScreen,
    validateSearch: (search: Record<string, unknown>) => ({
      next: typeof search.next === 'string' ? search.next : undefined,
    }) }),
  createRoute({ getParentRoute: () => rootRoute, path: '/register', component: RegisterScreen }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/reset-password',
    component: RequestResetScreen,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/reset-password/confirm',
    component: ResetPasswordScreen,
    validateSearch: tokenSearch,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/verify-email',
    component: VerifyEmailScreen,
    validateSearch: tokenSearch,
  }),

  createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <Protected>
        <DashboardScreen />
      </Protected>
    ),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/onboarding',
    component: () => (
      <Protected>
        <OnboardingScreen />
      </Protected>
    ),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: () => (
      <Protected>
        <SettingsScreen />
      </Protected>
    ),
  }),
];

const router = createRouter({
  routeTree: rootRoute.addChildren(routes),
  basepath: '/app',
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AdminThemeProvider storageKey="template.app.theme">
      <RouterProvider router={router} />
    </AdminThemeProvider>
  </React.StrictMode>,
);
