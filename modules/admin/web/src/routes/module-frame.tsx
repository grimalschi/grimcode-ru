import { useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { normalizeModulePath } from '@/frame/protocol';
import * as React from 'react';

import { useTheme } from '@/components/theme-provider';
import { Skeleton } from '@/components/ui/skeleton';
import { useModuleFrame } from '@/frame/use-module-frame';
import { adminModules } from '@/modules';
import { useSession } from '@/session';

/**
 * A module admin, embedded same-origin.
 *
 * The shell's URL is the canonical one — `/admin/module/email#/templates/123` — and the iframe is
 * pointed at `/admin/embed/module/email/templates/123`, which Router checks exactly as it would
 * if the administrator opened it directly.
 *
 * The shell never imports a module admin's code: composition happens over the frame protocol.
 */
export function ModuleFrame() {
  const { module: moduleId } = useParams({ from: '/module/$module' });
  const module = adminModules(useSession().catalogue).find(({ id }) => id === moduleId);
  const navigate = useNavigate();
  const frame = React.useRef<HTMLIFrameElement>(null);
  const { preference } = useTheme();

  // The hash is this shell's copy of the module-relative path.
  const hash = useRouterState({ select: (state) => state.location.hash });
  const path = normalizeModulePath(hash === '' ? '/' : hash);

  const onPathChange = React.useCallback(
    (next: string) => {
      // `replace` keeps navigation that happened inside the iframe out of the browser history a
      // second time: the iframe already added its own entry.
      void navigate({ to: '/module/$module', params: { module: moduleId }, hash: next, replace: true });
    },
    [navigate, moduleId],
  );

  const { loading } = useModuleFrame({
    frame,
    path,
    theme: preference,
    onPathChange,
  });

  // Built once per module: changing `src` on every navigation would reload the iframe and throw
  // away its state, so navigation inside a module goes through the frame protocol instead. The
  // component is keyed by the module, so choosing a different one mounts a fresh frame.
  //
  // Above the early return, because a hook that runs only sometimes breaks the order React relies
  // on the moment an unknown module is opened.
  const initialSrc = React.useRef(
    module ? `${module.embedHref.replace(/\/$/, '')}${path}` : '',
  ).current;

  if (!module) {
    return <div className="text-muted-foreground p-6">Такого модуля нет.</div>;
  }

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
        title={`Админка ${module.label}`}
        className="h-full w-full border-0"
        // Same-origin by design: the frame protocol and the session cookie both need it.
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
      />
    </div>
  );
}
