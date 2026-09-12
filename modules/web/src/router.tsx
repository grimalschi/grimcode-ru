import { createRouter as createTanStackRouter } from '@tanstack/react-router';

import { NotFound } from './components/not-found';
import { routeTree } from './routeTree.gen';

/**
 * The router factory the framework calls on both sides.
 *
 * It must be named `getRouter`: the server entry and the client hydration both import that name
 * from this file.
 */
export function getRouter() {
  return createTanStackRouter({
    routeTree,
    defaultPreload: 'intent',
    defaultNotFoundComponent: NotFound,
    trailingSlash: 'preserve',
    scrollRestoration: true,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
