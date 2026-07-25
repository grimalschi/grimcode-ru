import type { Migration } from '@template/shared';

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
    `,
  },
  {
    version: 2,
    name: 'event-status-index',
    sql: `
      CREATE INDEX events_type_status_idx ON events (type, status);
    `,
  },
];
