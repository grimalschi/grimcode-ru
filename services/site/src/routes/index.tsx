import { Link, createFileRoute } from '@tanstack/react-router';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'Шаблон' },
      {
        name: 'description',
        content: 'Сайт, приложение и админка, которые работают вместе с первого дня.',
      },
    ],
  }),
  component: Home,
});

const PARTS = [
  {
    title: 'Сайт',
    body: 'Эти публичные страницы. Они собираются на сервере, поэтому читаются и индексируются без JavaScript.',
  },
  {
    title: 'Приложение',
    body: 'Всё, что за входом: аккаунт, один экран настроек и то, что добавит сам продукт.',
  },
  {
    title: 'Админка',
    body: 'Роли, доступы и собственная админка каждого сервиса, собранные в одну панель.',
  },
];

function Home() {
  return (
    <div className="mx-auto w-full max-w-4xl px-6">
      <section className="py-20">
        <h1 className="text-4xl font-semibold tracking-tight text-balance">
          Продукт, у которого скучная часть уже готова
        </h1>
        <p className="text-muted-foreground mt-4 max-w-2xl text-lg">
          Аккаунты, письма, права и админка — работа, которую повторяет каждый продукт. Здесь она
          сделана, и первый день можно потратить на то, что действительно ваше.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <a href="/app/register">Создать аккаунт</a>
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link to="/about">Что внутри</Link>
          </Button>
        </div>
      </section>

      <section className="grid gap-4 pb-20 sm:grid-cols-3">
        {PARTS.map((part) => (
          <Card key={part.title}>
            <CardHeader>
              <CardTitle>{part.title}</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-sm">{part.body}</CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
