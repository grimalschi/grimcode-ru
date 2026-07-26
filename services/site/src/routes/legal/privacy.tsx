import { createFileRoute } from '@tanstack/react-router';

import { LegalPage } from '@/components/legal-page';

export const Route = createFileRoute('/legal/privacy')({
  head: () => ({
    meta: [
      { title: 'Privacy — Template' },
      { name: 'description', content: 'What personal data is collected, why, and for how long.' },
      { name: 'robots', content: 'noindex' },
    ],
  }),
  component: () => (
    <LegalPage
      title="Privacy policy"
      sections={[
        { heading: 'Who is responsible', body: 'The controller of the data, and how to reach them.' },
        { heading: 'What is collected', body: 'Email address, profile details, and technical records.' },
        { heading: 'Why', body: 'The purpose and the legal basis for each kind of data.' },
        { heading: 'Who else sees it', body: 'Processors such as the email provider and the hosting.' },
        { heading: 'How long it is kept', body: 'Retention periods, and what happens on deletion.' },
        { heading: 'Your rights', body: 'Access, correction, deletion, objection, and how to ask.' },
        { heading: 'Cookies', body: 'The session cookie is required; anything else needs consent.' },
      ]}
    />
  ),
});
