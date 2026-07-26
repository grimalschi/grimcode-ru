import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
} from '@tanstack/react-router';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';

import { api } from '@/api';
import { AppSidebar } from '@/components/app-sidebar';
import { AdminPage, EmptyState, ErrorState } from '@/components/layout/admin-page';
import { AdminThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { AdministratorsPage } from '@/routes/administrators';
import { AuditPage } from '@/routes/audit';
import { ServiceFrame } from '@/routes/service-frame';
import { loadSession, SessionProvider, useSession, type AdminSession } from '@/session';

import '@/styles.css';

/**
 * The central Admin shell.
 *
 * It owns the sidebar, the theme and the URL; service admins are composed in as same-origin
 * iframes. The shell never imports their code.
 */
function Shell() {
  const [session, setSession] = React.useState<AdminSession | null>(null);
  const [error, setError] = React.useState<unknown>(null);

  React.useEffect(() => {
    loadSession().then(setSession, setError);
  }, []);

  const logout = React.useCallback(() => {
    // Logout is a server-side operation: Auth invalidates the session and the server clears the
    // HttpOnly cookie. Dropping the cookie in the browser alone would leave the session usable.
    api
      .logout({})
      .then(() => window.location.assign('/'))
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      );
  }, []);

  if (error) {
    return (
      <div className="p-6">
        <ErrorState error={error} retry={() => window.location.reload()} />
      </div>
    );
  }

  // Nothing is rendered before the server has said who this is, so no screen can briefly assume a
  // role or a set of services the server would not grant.
  if (!session) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <SessionProvider value={session}>
      <SidebarProvider>
        <AppSidebar session={session} onLogout={logout} />
        <SidebarInset className="flex h-svh flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-auto">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Toaster position="bottom-right" />
    </SessionProvider>
  );
}

const rootRoute = createRootRoute({ component: Shell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  // `?service=email` is the canonical way the shell names what is open; the hash carries the
  // service-relative path inside it.
  validateSearch: (search: Record<string, unknown>) => ({
    service: typeof search.service === 'string' ? search.service : undefined,
  }),
  component: Home,
});

function Home() {
  const { service } = indexRoute.useSearch();
  // Keyed by the service, so switching to another one builds a new frame. Without it React reuses
  // the component, and the iframe keeps the src it was first given — the sidebar changes and the
  // page does not.
  if (service) return <ServiceFrame key={service} serviceId={service} />;

  return (
    <AdminPage title="Admin" description="Pick a service in the sidebar.">
      <EmptyState
        title="Nothing open"
        description="The sidebar lists the services your role and grants allow."
      />
    </AdminPage>
  );
}

const administratorsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/administrators',
  component: OwnerOnly(AdministratorsPage),
});

const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/audit',
  component: OwnerOnly(AuditPage),
});

/**
 * Hides an owner-only screen from a non-owner.
 *
 * This is presentation. The server refuses these calls for anyone but the owner regardless of what
 * the interface shows.
 */
function OwnerOnly(Component: React.ComponentType) {
  return function Guarded() {
    const navigate = useNavigate();
    const session = useSession();

    React.useEffect(() => {
      if (session.role !== 'owner') void navigate({ to: '/', search: { service: undefined }, replace: true });
    }, [navigate, session.role]);

    if (session.role !== 'owner') return null;
    return <Component />;
  };
}

const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, administratorsRoute, auditRoute]),
  basepath: '/admin',
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AdminThemeProvider>
      <RouterProvider router={router} />
    </AdminThemeProvider>
  </React.StrictMode>,
);
