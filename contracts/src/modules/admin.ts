export type AdminRole = 'owner' | 'admin';

export type AdminTarget =
  | { area: 'panel' }
  | { area: 'module'; module: string };

export interface AdminContext {
  userId: string;
  email: string;
  role: AdminRole;
}

export type AuthorizationResult =
  | { state: 'allowed'; userId: string; email: string; role: AdminRole }
  | {
    state: 'denied';
    reason: 'no-session' | 'not-an-administrator' | 'disabled' | 'no-grant' |
      'owner-only' | 'unknown-module';
  }
  | { state: 'awaiting-first-user' };

export interface AdminApi {
  authorize: (input: {
    sessionToken: string | null;
    target: AdminTarget;
  }) => Promise<AuthorizationResult>;
}

export interface Administrator {
  id: string;
  userId: string;
  email: string;
  role: AdminRole;
  enabled: boolean;
  grants: string[];
  createdAt: string;
  updatedAt: string;
}
