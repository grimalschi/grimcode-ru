/**
 * What a neighbour may see of this module: `@template/users` resolves to `createApp` and its
 * types, `@template/users/contract` to here, `dist/repository.js` to nothing at all.
 *
 * A projection of the implementation, not an agreement: `.output()` on every procedure and the
 * `satisfies` line are what keep it honest.
 */
export type { UsersAdminRouter, UsersPublicRouter } from './routers.js';

/**
 * The shapes themselves, for the two bundles that render them. A Zod object is a value and must
 * not travel through this file, so what crosses is the inferred type and never the schema.
 */
export type { AdminUserProfile, UserProfile } from './schemas.js';
