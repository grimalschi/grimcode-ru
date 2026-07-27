import { useNavigate, useRouterState } from '@tanstack/react-router';
import { normalizeServicePath } from '@template/shared/browser';
import * as React from 'react';

import { useTheme } from '@/components/theme-provider';
import { Skeleton } from '@/components/ui/skeleton';
import { useServiceFrame } from '@/frame/use-service-frame';
import { findAdminService } from '@/services';

/**
 * A service admin, embedded same-origin.
 *
 * The shell's URL is the canonical one — `/admin?service=email#/templates/123` — and the iframe is
 * pointed at the protected URL `/admin/service/email/templates/123`, which Gateway checks exactly
 * as it would if the administrator opened it directly.
 *
 * The shell never imports a service admin's code: composition happens over the frame protocol.
 */
export function ServiceFrame({ serviceId }: { serviceId: string }) {
  const service = findAdminService(serviceId);
  const navigate = useNavigate();
  const frame = React.useRef<HTMLIFrameElement>(null);
  const { preference } = useTheme();

  // The hash is this shell's copy of the service-relative path.
  const hash = useRouterState({ select: (state) => state.location.hash });
  const path = normalizeServicePath(hash === '' ? '/' : hash);

  const onPathChange = React.useCallback(
    (next: string) => {
      // `replace` keeps navigation that happened inside the iframe out of the browser history a
      // second time: the iframe already added its own entry.
      void navigate({
        to: '/',
        search: { service: serviceId, database: undefined },
        hash: next,
        replace: true,
      });
    },
    [navigate, serviceId],
  );

  const { loading } = useServiceFrame({
    frame,
    path,
    theme: preference,
    onPathChange: service?.syncPath ? onPathChange : noop,
  });

  if (!service) {
    return (
      <div className="text-muted-foreground p-6">Такого сервиса нет.</div>
    );
  }

  // Built once per service: changing `src` on every navigation would reload the iframe and throw
  // away its state, so navigation inside a service goes through the frame protocol instead. The
  // component is keyed by the service, so choosing a different one mounts a fresh frame.
  const initialSrc = React.useRef(`${service.href.replace(/\/$/, '')}${path}`).current;

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
        src={initialSrc}
        title={`Админка ${service.label}`}
        className="h-full w-full border-0"
        // Same-origin by design: the frame protocol and the session cookie both need it.
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
      />
    </div>
  );
}

function noop() {}
