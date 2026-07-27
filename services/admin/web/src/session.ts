import type { AdminServiceId } from '@template/contracts';
import * as React from 'react';

import { api } from '@/api';

export interface AdminSession {
  userId: string;
  email: string;
  role: 'owner' | 'admin';
  services: AdminServiceId[];
  /** Whether the panel offers its database browser. Owners only. */
  database: boolean;
}

const SessionContext = React.createContext<AdminSession | null>(null);

export const SessionProvider = SessionContext.Provider;

/**
 * The current administrator, as the server sees them.
 *
 * The shell renders nothing before this resolves, so no screen can briefly assume a role or a set
 * of services that the server would not grant.
 */
export function useSession(): AdminSession {
  const session = React.useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside a resolved SessionProvider');
  return session;
}

export function loadSession(): Promise<AdminSession> {
  return api.session({}) as Promise<AdminSession>;
}
