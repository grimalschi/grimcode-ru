import { createFileRoute } from '@tanstack/react-router';

import { LegalPage } from '@/components/legal-page';

export const Route = createFileRoute('/legal/privacy')({
  head: () => ({
    meta: [
      { title: 'Конфиденциальность — Шаблон' },
      { name: 'description', content: 'Какие персональные данные собираются, зачем и на какой срок.' },
      { name: 'robots', content: 'noindex' },
    ],
  }),
  component: () => (
    <LegalPage
      title="Политика конфиденциальности"
      sections={[
        { heading: 'Кто отвечает', body: 'Оператор данных и как с ним связаться.' },
        { heading: 'Что собирается', body: 'Адрес почты, данные профиля и технические записи.' },
        { heading: 'Зачем', body: 'Цель и основание для каждого вида данных.' },
        { heading: 'Кто ещё видит', body: 'Обработчики: почтовый провайдер, хостинг и подобные.' },
        { heading: 'Сколько хранится', body: 'Сроки хранения и что происходит при удалении.' },
        { heading: 'Ваши права', body: 'Доступ, исправление, удаление, возражение и как их заявить.' },
        { heading: 'Cookies', body: 'Сессионная cookie обязательна; на остальное нужно согласие.' },
      ]}
    />
  ),
});
