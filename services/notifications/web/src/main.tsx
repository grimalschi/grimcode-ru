import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import * as React from 'react';
import { createRoot } from 'react-dom/client';

import { AdminThemeProvider } from '@/components/theme-provider';
import { ThemeToggle } from '@/components/theme-toggle';
import { Toaster } from '@/components/ui/sonner';
import { useFrameChild } from '@/frame/use-frame-child';
import { EventsPage } from '@/routes/events';

import '@/styles.css';

const BASE = '/admin/embed/service/notifications';

const TABS = [{ to: '/', label: 'События' }];

/**
 * The Notifications service admin.
 *
 * It normally runs inside the central Admin shell's iframe, but its protected URL also works on
 * its own — Gateway performs the same check either way. Standing alone it shows its own header;
 * embedded, the shell already provides one.
 */
function Shell() {
  const navigate = useNavigate();
  const path = useRouterState({ select: (state) => state.location.pathname });

  const onNavigate = React.useCallback(
    (next: string) => {
      void navigate({ to: next, replace: true });
    },
    [navigate],
  );

  const { embedded, theme } = useFrameChild({ path, onNavigate });

  return (
    <AdminThemeProvider storageKey="template.notifications.theme" controlledTheme={theme}>
      <div className="min-h-svh">
        {TABS.length > 1 || !embedded ? (
        <header className="flex h-12 items-center justify-between gap-4 border-b px-4">
          <nav className="flex items-center gap-4 text-sm">
            {TABS.length > 1 && TABS.map((tab) => (
              <Link
                key={tab.to}
                to={tab.to}
                className="[&.active]:text-foreground text-muted-foreground [&.active]:font-medium"
                activeOptions={{ exact: tab.to === '/' }}
              >
                {tab.label}
              </Link>
            ))}
          </nav>
          {/* The shell owns the theme when embedded, so the switch would only disagree with it. */}
          {embedded ? null : <ThemeToggle />}
        </header>
        ) : null}
        <Outlet />
      </div>
      <Toaster position="bottom-right" />
    </AdminThemeProvider>
  );
}

const rootRoute = createRootRoute({ component: Shell });

const router = createRouter({
  routeTree: rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: '/', component: EventsPage }),
  ]),
  basepath: BASE,
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
