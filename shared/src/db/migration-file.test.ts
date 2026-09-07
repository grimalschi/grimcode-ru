import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { migrationChecksum } from './migrator.js';
import {
  canWriteMigrations,
  highestMigrationVersion,
  writeMigration,
} from './migration-file.js';

/**
 * A folder as a module keeps one: a first migration, and the list the migrator is handed.
 *
 * Written out here rather than copied from a module, because what is being tested is that a file
 * written by machine still fits a folder written by hand.
 */
function folderWithOneMigration(): string {
  const folder = join(mkdtempSync(join(tmpdir(), 'migrations-')), 'migrations');
  mkdirSync(folder);

  writeFileSync(
    join(folder, '001-profiles.ts'),
    `import type { Migration } from '@template/shared';

export const migration: Migration = {
  version: 1,
  name: 'profiles',
  sql: \`
      CREATE TABLE profiles (id uuid PRIMARY KEY);
    \`,
};
`,
    'utf8',
  );

  writeFileSync(
    join(folder, 'index.ts'),
    `import type { Migration } from '@template/shared';

import { migration as version1 } from './001-profiles.js';

export const migrations: readonly Migration[] = [version1];
`,
    'utf8',
  );

  return folder;
}

describe('writing a migration into a module', () => {
  it('adds the file and puts it in the list, after the ones already there', () => {
    const folder = folderWithOneMigration();

    writeMigration(folder, {
      version: 2,
      name: 'interface-add-public-profiles-notes',
      sql: 'ALTER TABLE "public"."profiles" ADD COLUMN "notes" text',
    });

    const index = readFileSync(join(folder, 'index.ts'), 'utf8');
    expect(index).toContain(
      "import { migration as version2 } from './002-interface-add-public-profiles-notes.js';",
    );
    expect(index).toContain('export const migrations: readonly Migration[] = [version1, version2];');

    // Order is the order they run in, so the new one goes last rather than wherever it sorts.
    expect(index.indexOf('version1')).toBeLessThan(index.indexOf('version2'));
  });

  /**
   * The written statement must checksum to what was recorded when it ran.
   *
   * This is the whole reason the file puts the statement on a line of its own: `runMigrations` takes
   * the checksum of the trimmed text, so the newlines around it fall away and what is left is exactly
   * the statement that was executed. A space more in the wrong place and the module refuses to start.
   */
  it('writes a statement that still checksums to what was applied', () => {
    const folder = folderWithOneMigration();
    const sql = 'ALTER TABLE "public"."profiles" ADD COLUMN "notes" text';

    writeMigration(folder, { version: 2, name: 'interface-add-public-profiles-notes', sql });

    const written = readFileSync(
      join(folder, '002-interface-add-public-profiles-notes.ts'),
      'utf8',
    );
    const inside = /sql: `([\s\S]*?)`,/.exec(written)?.[1] ?? '';

    expect(inside.trim()).toBe(sql);
    expect(migrationChecksum(inside)).toBe(migrationChecksum(sql));
  });

  it('reads the highest version from the files, not from the list', () => {
    const folder = folderWithOneMigration();
    expect(highestMigrationVersion(folder)).toBe(1);

    writeMigration(folder, { version: 7, name: 'interface-drop-public-profiles-notes', sql: 'SELECT 1' });
    expect(highestMigrationVersion(folder)).toBe(7);
  });

  it('says whether a folder can be written into at all', () => {
    expect(canWriteMigrations(folderWithOneMigration())).toBe(true);
    expect(canWriteMigrations(join(tmpdir(), 'no-such-folder-here'))).toBe(false);
  });

  it('refuses a list it does not recognise rather than mangling it', () => {
    const folder = join(mkdtempSync(join(tmpdir(), 'migrations-')), 'migrations');
    mkdirSync(folder);
    writeFileSync(join(folder, 'index.ts'), 'export const migrations = [];\n', 'utf8');

    expect(() => writeMigration(folder, { version: 1, name: 'interface-add-a-b-c', sql: 'SELECT 1' })).toThrow(
      /imports no migration/,
    );
  });
});
