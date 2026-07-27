import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/contact')({
  head: () => ({
    meta: [
      { title: 'Контакты — Шаблон' },
      { name: 'description', content: 'Как связаться с теми, кто делает продукт.' },
    ],
  }),
  component: Contact,
});

function Contact() {
  return (
    <article className="mx-auto w-full max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Контакты</h1>
      <p className="text-muted-foreground mt-4">
        Замените данные ниже на настоящие до запуска.
      </p>

      <dl className="mt-8 grid grid-cols-[8rem_1fr] gap-y-3 text-sm">
        <dt className="text-muted-foreground">Почта</dt>
        <dd>hello@example.com</dd>
        <dt className="text-muted-foreground">Компания</dt>
        <dd>Название, регистрационный номер</dd>
        <dt className="text-muted-foreground">Адрес</dt>
        <dd>Улица, город, страна</dd>
      </dl>
    </article>
  );
}
