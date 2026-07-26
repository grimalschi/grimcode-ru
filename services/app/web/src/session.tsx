import * as React from 'react';

import { auth } from '@/api';

export interface Identity {
  id: string;
  email: string;
  emailVerifiedAt: string | null;
  blockedAt: string | null;
  createdAt: string;
}

interface SessionValue {
  identity: Identity | null;
  /** False once Auth has answered, so a guard never acts on an unknown state. */
  loading: boolean;
  /** Re-reads the session from Auth; used after login, logout and email changes. */
  refresh: () => Promise<Identity | null>;
}

const SessionContext = React.createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = React.useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

/**
 * Asks Auth who the current user is.
 *
 * This is the application's own copy of the answer, kept so the interface can be correct while
 * navigating. It is not a security boundary: Auth, Users and every other service check the session
 * again on each protected endpoint, and a revoked session fails there regardless of what this
 * value still says.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [identity, setIdentity] = React.useState<Identity | null>(null);
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(async () => {
    try {
      const result = await auth.currentSession({});
      const next = (result.identity ?? null) as Identity | null;
      setIdentity(next);
      return next;
    } catch {
      // A failure to reach Auth is treated as "not signed in": the guard then sends the visitor to
      // the login page instead of rendering a protected screen on a guess.
      setIdentity(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = React.useMemo(
    () => ({ identity, loading, refresh }),
    [identity, loading, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
