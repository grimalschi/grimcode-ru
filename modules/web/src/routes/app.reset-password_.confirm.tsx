import { createFileRoute } from '@tanstack/react-router';

import { ResetPasswordScreen } from '@/screens/auth-screens';

export const Route = createFileRoute('/app/reset-password_/confirm')({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  component: ResetPasswordScreen,
});
