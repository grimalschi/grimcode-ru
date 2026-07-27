import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/about')({
  head: () => ({
    meta: [
      { title: 'О проекте — Шаблон' },
      { name: 'description', content: 'Что в этом шаблоне и зачем.' },
    ],
  }),
  component: About,
});

function About() {
  return (
    <article className="prose-page mx-auto w-full max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">О проекте</h1>
      <p className="text-muted-foreground mt-4">
        Это заглушка с настоящей структурой: продукт заменяет слова и оставляет форму.
      </p>

      <h2 className="mt-10 text-xl font-medium">Что это</h2>
      <p className="text-muted-foreground mt-2">
        Набор небольших сервисов, которые уже работают вместе: публичный сайт, приложение за входом
        и админка с ролями и доступами.
      </p>

      <h2 className="mt-8 text-xl font-medium">Как устроено</h2>
      <p className="text-muted-foreground mt-2">
        Каждый сервис владеет своими данными и своим интерфейсом. Они общаются по типизированным
        контрактам и не импортируют код друг друга, поэтому любой можно заменить, не трогая остальные.
      </p>
    </article>
  );
}
