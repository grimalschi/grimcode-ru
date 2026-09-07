import type { Migration } from '@template/shared';

import { migration as version1 } from './001-administrators-grants-audit.js';

/**
 * Versioned migrations of the Admin database.
 *
 * `user_id` references an Auth identity and deliberately carries no foreign key: identities live
 * in the Auth database, which Admin may never read or reference.
 *
 * The template starts at one migration: this is the schema a new project inherits, not a record of
 * how it was arrived at. Every change after the first clone is a new version.
 */
export const migrations: readonly Migration[] = [version1];
