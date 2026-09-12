import { createFileRoute } from '@tanstack/react-router';

import { ConfirmEmailChangeScreen } from '@/screens/auth-screens';

export const Route = createFileRoute('/app/confirm-email-change')({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  component: ConfirmEmailChangeScreen,
});
