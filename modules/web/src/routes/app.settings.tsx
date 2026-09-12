import { createFileRoute } from '@tanstack/react-router';

import { Protected } from '@/components/layout/protected';
import { SettingsScreen } from '@/screens/settings';

export const Route = createFileRoute('/app/settings')({
  component: () => (
    <Protected>
      <SettingsScreen />
    </Protected>
  ),
});
