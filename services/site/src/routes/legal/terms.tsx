import { createFileRoute } from '@tanstack/react-router';

import { LegalPage } from '@/components/legal-page';

export const Route = createFileRoute('/legal/terms')({
  head: () => ({
    meta: [
      { title: 'Условия — Шаблон' },
      { name: 'description', content: 'Соглашение между продуктом и теми, кто им пользуется.' },
      // A placeholder must never be indexed as if it were a real agreement.
      { name: 'robots', content: 'noindex' },
    ],
  }),
  component: () => (
    <LegalPage
      title="Условия использования"
      sections={[
        { heading: 'Кто мы', body: 'Юридическое лицо, реквизиты и адрес для связи.' },
        { heading: 'Услуга', body: 'Что предоставляется и на каких условиях этим можно пользоваться.' },
        { heading: 'Аккаунты', body: 'За что отвечает человек, у которого есть аккаунт.' },
        { heading: 'Оплата', body: 'Цены, периоды списания, возвраты — если продукт платный.' },
        { heading: 'Ответственность', body: 'Границы ответственности каждой из сторон.' },
        { heading: 'Прекращение', body: 'Как любая из сторон может остановиться и что тогда будет.' },
        { heading: 'Изменения', body: 'Как объявляются изменения и когда они вступают в силу.' },
      ]}
    />
  ),
});
