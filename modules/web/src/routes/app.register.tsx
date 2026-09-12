import { createFileRoute } from '@tanstack/react-router';

import { RegisterScreen } from '@/screens/auth-screens';

export const Route = createFileRoute('/app/register')({
  component: RegisterScreen,
});
