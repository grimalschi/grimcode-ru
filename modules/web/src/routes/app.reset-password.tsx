import { createFileRoute } from '@tanstack/react-router';

import { RequestResetScreen } from '@/screens/auth-screens';

export const Route = createFileRoute('/app/reset-password')({
  component: RequestResetScreen,
});
