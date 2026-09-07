import type { Migration } from '@template/shared';

import { migration as version1 } from './001-identities-sessions-tokens-audit.js';

/**
 * Versioned migrations of the Auth database.
 *
 * Versions are immutable once released: a fresh database is built from version 1 upwards and an
 * existing one only receives what it is missing. Changing a released statement is an error — add a
 * new version instead.
 *
 * The template starts at one, which is the schema a new project inherits rather than a record of
 * how it was arrived at.
 */
export const migrations: readonly Migration[] = [version1];
