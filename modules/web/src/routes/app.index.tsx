import { createFileRoute } from '@tanstack/react-router';

import { Protected } from '@/components/layout/protected';
import { DashboardScreen } from '@/screens/dashboard';

export const Route = createFileRoute('/app/')({
  component: () => (
    <Protected>
      <DashboardScreen />
    </Protected>
  ),
});
