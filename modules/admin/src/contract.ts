/**
 * What a neighbour may see of this module: `@template/admin` resolves to `createApp` and its
 * types, `@template/admin/contract` to here, `dist/repository.js` to nothing at all.
 *
 * A projection of the implementation, not an agreement: `.output()` on every procedure and the
 * `satisfies` line are what keep it honest.
 */
export type { AdminPanelRouter } from './routers.js';

/** What Gateway holds to ask this module: the caller, not the router. */
export type { AdminInternalCaller } from './index.js';

/**
 * The decision Gateway acts on. It is a discriminated union rather than a boolean because Gateway
 * must never interpret a failure: every refusal names itself, and the one that is not a refusal —
 * `awaiting-first-user` — is a page, not a 403.
 */
export type { AuthorizationResult } from './schemas.js';
