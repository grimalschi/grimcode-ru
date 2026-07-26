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
  {
    version: 3,
    name: 'suppressed-events',
    sql: `
      -- An event the recipient's preferences told us not to send. It is recorded rather than
      -- dropped, so "why did they not get it" has an answer that is not a shrug.
      ALTER TABLE events DROP CONSTRAINT events_status_check;
      ALTER TABLE events ADD CONSTRAINT events_status_check
        CHECK (status IN ('accepted', 'routed', 'failed', 'suppressed'));
    `,
  },
  {
    version: 4,
    name: 'drop-suppressed-events',
    sql: `
      -- The email preference it existed for is gone, so nothing can produce this status any more.
      -- Applied forward rather than by editing migration 3, which has already run elsewhere.
      UPDATE events SET status = 'failed', error = 'Suppressed before the preference was removed.'
       WHERE status = 'suppressed';

      ALTER TABLE events DROP CONSTRAINT events_status_check;
      ALTER TABLE events ADD CONSTRAINT events_status_check
        CHECK (status IN ('accepted', 'routed', 'failed'));
    `,
  },
];
