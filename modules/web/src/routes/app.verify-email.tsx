import { createFileRoute } from '@tanstack/react-router';

import { VerifyEmailScreen } from '@/screens/auth-screens';

export const Route = createFileRoute('/app/verify-email')({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  component: VerifyEmailScreen,
});
