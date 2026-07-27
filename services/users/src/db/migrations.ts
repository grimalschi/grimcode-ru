import type { Migration } from '@template/shared';

/**
 * Versioned migrations of the Users database.
 *
 * `identity_id` has no foreign key on purpose: the identity lives in the Auth database, which Users
 * may never read or reference. The link is a contract, not a join.
 *
 * The template starts at one migration: this is the schema a new project inherits, not a record of
 * how it was arrived at. Every change after the first clone is a new version.
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'profiles',
    sql: `
      -- The profile is a display name. A theme, a time zone or an email preference would be three
      -- things every project deletes before adding its own shape.
      CREATE TABLE profiles (
        id           uuid PRIMARY KEY,
        identity_id  uuid NOT NULL UNIQUE,
        display_name text,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX profiles_created_idx ON profiles (created_at DESC);
      CREATE INDEX profiles_display_name_lower_idx ON profiles (lower(display_name));
    `,
  },
];
