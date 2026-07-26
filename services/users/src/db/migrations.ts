import type { Migration } from '@template/shared';

/**
 * Versioned migrations of the Users database.
 *
 * `identity_id` has no foreign key on purpose: the identity lives in the Auth database, which
 * Users may never read or reference. The link is a contract, not a join.
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'profiles',
    sql: `
      CREATE TABLE profiles (
        id                      uuid PRIMARY KEY,
        identity_id             uuid NOT NULL UNIQUE,
        display_name            text,
        time_zone               text,
        locale                  text NOT NULL DEFAULT 'en',
        theme                   text NOT NULL DEFAULT 'system'
                                CHECK (theme IN ('light', 'dark', 'system')),
        product_emails          boolean NOT NULL DEFAULT true,
        onboarding_completed_at timestamptz,
        created_at              timestamptz NOT NULL DEFAULT now(),
        updated_at              timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    version: 2,
    name: 'profile-listing-indexes',
    sql: `
      CREATE INDEX profiles_created_idx ON profiles (created_at DESC);
      CREATE INDEX profiles_display_name_lower_idx ON profiles (lower(display_name));
    `,
  },
  {
    version: 3,
    name: 'drop-onboarding',
    sql: `
      -- Onboarding is not part of the template. A product that wants a first-run flow owns its own
      -- completion state, which is rarely a single timestamp, so keeping this column would have
      -- been guessing at a shape.
      ALTER TABLE profiles DROP COLUMN onboarding_completed_at;
    `,
  },
];
