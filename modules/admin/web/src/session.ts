import * as React from 'react';

import type { api } from '@/api';

export type AdminSession = Awaited<ReturnType<typeof api.session.query>>;

const SessionContext = React.createContext<AdminSession | null>(null);

export const SessionProvider = SessionContext.Provider;

/**
 * The current administrator, as the server sees them.
 *
 * The shell renders nothing before this resolves, so no screen can briefly assume a role or a set
 * of modules that the server would not grant.
 */
export function useSession(): AdminSession {
  const session = React.useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside a resolved SessionProvider');
  return session;
}
