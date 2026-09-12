import { createFileRoute } from '@tanstack/react-router';

import { LoginScreen } from '@/screens/auth-screens';

export const Route = createFileRoute('/app/login')({
  validateSearch: (search: Record<string, unknown>) => ({
    next: typeof search.next === 'string' ? search.next : undefined,
  }),
  component: LoginScreen,
});
