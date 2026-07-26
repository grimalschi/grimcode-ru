import { createFileRoute } from '@tanstack/react-router';

import { LegalPage } from '@/components/legal-page';

export const Route = createFileRoute('/legal/terms')({
  head: () => ({
    meta: [
      { title: 'Terms — Template' },
      { name: 'description', content: 'The agreement between the product and the people using it.' },
      // A placeholder must never be indexed as if it were a real agreement.
      { name: 'robots', content: 'noindex' },
    ],
  }),
  component: () => (
    <LegalPage
      title="Terms of service"
      sections={[
        { heading: 'Who we are', body: 'Legal entity, registration details and contact address.' },
        { heading: 'The service', body: 'What is provided, and on what terms it may be used.' },
        { heading: 'Accounts', body: 'What a person is responsible for when holding an account.' },
        { heading: 'Payment', body: 'Prices, billing periods, refunds — if the product charges.' },
        { heading: 'Liability', body: 'The limits of responsibility on both sides.' },
        { heading: 'Ending the agreement', body: 'How either side may stop, and what happens then.' },
        { heading: 'Changes', body: 'How changes are announced and when they take effect.' },
      ]}
    />
  ),
});
