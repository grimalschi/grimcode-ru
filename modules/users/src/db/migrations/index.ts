import type { Migration } from '@template/shared';

import { migration as version1 } from './001-profiles.js';

/**
 * Versioned migrations of the Users database.
 *
 * `identity_id` has no foreign key on purpose: the identity lives in the Auth database, which Users
 * may never read or reference. The link is a contract, not a join.
 *
 * The template starts at one migration: this is the schema a new project inherits, not a record of
 * how it was arrived at. Every change after the first clone is a new version.
 */
export const migrations: readonly Migration[] = [version1];
