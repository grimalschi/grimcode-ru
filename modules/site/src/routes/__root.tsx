import { HeadContent, Link, Outlet, Scripts, createRootRoute } from '@tanstack/react-router';

import { Separator } from '@/components/ui/separator';

// Imported for its side effect, not as a URL: the client and server builds hash assets
// independently, so a `?url` import here produces a link to a file that does not exist. The
// framework collects the stylesheet from this import and emits the correct tag.
import '@/styles.css';

/**
 * The public shell.
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
  component: RootLayout,
  notFoundComponent: NotFound,
});

const NAVIGATION = [
  { to: '/', label: 'Главная' },
  { to: '/about', label: 'О проекте' },
  { to: '/contact', label: 'Контакты' },
];

function RootLayout() {
  return (
    <html lang="ru">
      <head>
        <HeadContent />
      </head>
      <body>
        <div className="flex min-h-svh flex-col">
          <header className="border-b">
            <div className="mx-auto flex h-14 w-full max-w-4xl items-center justify-between gap-4 px-6">
              <Link to="/" className="font-semibold">
                Шаблон
              </Link>
              <nav className="flex items-center gap-4 text-sm">
                {NAVIGATION.map((item) => (
                  <Link
                    key={item.to}
                    to={item.to}
                    className="[&.active]:text-foreground text-muted-foreground"
                  >
                    {item.label}
                  </Link>
                ))}
                <a href="/app/" className="font-medium">
                  Войти
                </a>
              </nav>
            </div>
          </header>

          <main className="flex-1">
            <Outlet />
          </main>

          <footer className="mt-16 border-t">
            <div className="text-muted-foreground mx-auto w-full max-w-4xl space-y-3 px-6 py-8 text-sm">
              <Separator />
              <nav className="flex flex-wrap gap-4">
                <Link to="/legal/terms">Условия</Link>
                <Link to="/legal/privacy">Конфиденциальность</Link>
                <Link to="/contact">Контакты</Link>
              </nav>
              <p>© Шаблон</p>
            </div>
          </footer>
        </div>
        <Scripts />
      </body>
    </html>
  );
}

function NotFound() {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-24">
      <h1 className="text-3xl font-semibold">Такой страницы нет</h1>
      <p className="text-muted-foreground mt-2">
        Возможно, в адресе опечатка или страницу удалили.
      </p>
      <Link to="/" className="mt-6 inline-block underline underline-offset-4">
        На главную
      </Link>
    </div>
  );
}
