import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router';

import type * as React from 'react';

import { themeScript } from '@/theme';

// Imported for its side effect, not as a URL: the client and server builds hash assets
// independently, so a `?url` import here produces a link to a file that does not exist. The
// framework collects the stylesheet from this import and emits the correct tag.
import '@/styles.css';

/**
 * Shared document shell. Public navigation belongs to the pathless _site layout.
 *
 * Metadata lives here rather than in each page, so a page that forgets to describe itself still
 * has a title, a description and a favicon.
 */
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Шаблон' },
      {
        name: 'description',
        content: 'Рабочий шаблон небольшого продукта: сайт, приложение и админка.',
      },
      { property: 'og:title', content: 'Шаблон' },
      { property: 'og:type', content: 'website' },
    ],
    links: [{ rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
  }),
  component: Outlet,
  shellComponent: RootShell,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
