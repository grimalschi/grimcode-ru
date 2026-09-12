import { createFileRoute, Outlet } from '@tanstack/react-router';

import { ThemeProvider } from '@/components/theme-provider';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { SessionProvider } from '@/session';

/** Public pages render on the server; product screens resolve their session in the browser. */
export const Route = createFileRoute('/app')({
  ssr: false,
  head: () => ({ meta: [{ title: 'Приложение' }, { name: 'robots', content: 'noindex' }] }),
  pendingComponent: AppPending,
  component: AppLayout,
});

function AppLayout() {
  return (
    <ThemeProvider>
      <SessionProvider>
        <Outlet />
        <Toaster position="bottom-right" />
      </SessionProvider>
    </ThemeProvider>
  );
}

function AppPending() {
  return (
    <div className="space-y-4 p-6" aria-label="Загрузка приложения">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
