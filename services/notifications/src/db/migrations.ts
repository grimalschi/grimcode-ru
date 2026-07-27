import type { Migration } from '@template/shared';

/**
 * Versioned migrations of the Notifications database.
 *
 * The template starts at one migration: this is the schema a new project inherits, not a record of
 * how it was arrived at. Every change after the first clone is a new version.
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'events',
    sql: `
      CREATE TABLE events (
        id              uuid PRIMARY KEY,
        type            text NOT NULL,
        -- The caller's idempotency key. The unique index is what actually prevents a repeated
        -- delivery of the same event from being routed twice.
        dedupe_key      text NOT NULL,
        recipient_email text NOT NULL,
        payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
        status          text NOT NULL DEFAULT 'accepted'
                        CHECK (status IN ('accepted', 'routed', 'failed')),
        error           text,
        delivery_id     uuid,
        created_at      timestamptz NOT NULL DEFAULT now(),
        routed_at       timestamptz
      );

      CREATE UNIQUE INDEX events_dedupe_key_idx ON events (dedupe_key);
      CREATE INDEX events_created_idx ON events (created_at DESC);
      CREATE INDEX events_type_status_idx ON events (type, status);
    `,
  },
];
