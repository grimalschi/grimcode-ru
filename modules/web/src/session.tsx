import type { Identity } from '@template/contracts/modules/auth';
import * as React from 'react';

import { auth } from '@/api';

interface SessionValue {
  identity: Identity | null;
  /** False once Auth has answered, so a guard never acts on an unknown state. */
  loading: boolean;
  /** Re-reads the session from Auth, as after an email change; returning to the tab does it too. */
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
 * navigating. It is not a security boundary: Auth, Users and every other module check the session
 * again on each protected endpoint, and a revoked session fails there regardless of what this
 * value still says.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [identity, setIdentity] = React.useState<Identity | null>(null);
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(async () => {
    try {
      const result = await auth.currentSession.query({});
      const next = result.identity ?? null;
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

  // Coming back to the tab re-reads the answer: an address confirmed from the letter in another tab
  // shows as confirmed without a button to press, and a session ended elsewhere ends here too. A
  // failure to reach Auth on the way back changes nothing — a laptop waking up offline is not a sign-out.
  React.useEffect(() => {
    const revisit = () => {
      if (document.visibilityState !== 'visible') return;
      auth.currentSession
        .query({})
        .then((result) => setIdentity(result.identity ?? null))
        .catch(() => {});
    };
    document.addEventListener('visibilitychange', revisit);
    return () => document.removeEventListener('visibilitychange', revisit);
  }, []);

  const value = React.useMemo(
    () => ({ identity, loading, refresh }),
    [identity, loading, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
