export const migration = {
  version: 1,
  name: 'profiles',
  sql: `
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
