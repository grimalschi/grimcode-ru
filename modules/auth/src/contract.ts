/**
 * Types only — a value here and the `exports` key becomes a formality. Auth has the most callers and
 * holds password hashes, sessions and one-time tokens, all behind `repository.ts`, which no
 * specifier reaches. What keeps this honest is `.output()` on every procedure.
 */
export type { AuthAdminRouter } from './routers/admin.js';
export type { AuthPublicRouter } from './routers/public.js';

/** What a neighbour holds to call this module: the caller, not the router. */
export type { AuthInternalCaller } from './index.js';

/** Inferred from `schemas.ts`: a Zod object is a value, and values must not cross this file. */
export type {
  AdminIdentity,
  AuthAuditEntry,
  Identity,
  SessionSummary,
} from './schemas.js';
