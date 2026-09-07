import type { Migration } from '@template/shared';

import { migration as version1 } from './001-templates-versions-deliveries.js';

/**
 * Versioned migrations of the Email database.
 *
 * The template starts at one migration on purpose: this is the schema a new project inherits, not a
 * record of how it was arrived at. Every change after the first clone is a new version, and a
 * released version is never edited — the migrator refuses a changed checksum.
 */
export const migrations: readonly Migration[] = [version1];
