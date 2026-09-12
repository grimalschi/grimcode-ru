import { Link, Outlet, createFileRoute } from '@tanstack/react-router';

import { Separator } from '@/components/ui/separator';

export const Route = createFileRoute('/_site')({ component: SiteLayout });

const NAVIGATION = [
  { to: '/', label: 'Главная' },
  { to: '/about', label: 'О проекте' },
  { to: '/contact', label: 'Контакты' },
];

function SiteLayout() {
  return (
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
            <Link to="/app/" className="font-medium">
              Войти
            </Link>
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
  );
}
