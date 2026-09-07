import type { Migration } from '@template/shared';

/**
 * The schema this module starts from.
 *
 * The statement is stored as it was applied, indentation included: the migrator remembers a version by
 * the checksum of this text, so re-indenting it — by one space — makes the module refuse to start
 * against a database that has already run it. Nothing here is reformatted, ever.
 */
export const migration: Migration = {
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
};
