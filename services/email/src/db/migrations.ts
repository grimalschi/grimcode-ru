import type { Migration } from '@template/shared';

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'templates-versions-deliveries',
    sql: `
      CREATE TABLE templates (
        id          uuid PRIMARY KEY,
        key         text NOT NULL UNIQUE,
        name        text NOT NULL,
        description text,
        -- Variables the editor may reference and the publish step validates against.
        variables   jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE template_versions (
        id              uuid PRIMARY KEY,
        template_id     uuid NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
        locale          text NOT NULL,
        version         integer NOT NULL,
        status          text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'archived')),
        subject         text NOT NULL,
        -- The editor's own document, kept verbatim, next to the marker of its format. Moving the
        -- marker forward is a separate migration, never an implicit rewrite on library upgrade.
        editor_format   text NOT NULL,
        editor_document jsonb NOT NULL,
        -- Produced by the server on publish. Runtime delivery only ever uses these.
        compiled_html   text,
        compiled_text   text,
        published_at    timestamptz,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (template_id, locale, version)
      );

      -- At most one published version per template and locale, so runtime delivery is never
      -- ambiguous about which content it must send.
      CREATE UNIQUE INDEX template_versions_published_idx
        ON template_versions (template_id, locale) WHERE status = 'published';

      CREATE TABLE deliveries (
        id                  uuid PRIMARY KEY,
        -- Idempotency key of the caller; the unique index is what prevents a double send.
        dedupe_key          text NOT NULL UNIQUE,
        template_key        text NOT NULL,
        template_version_id uuid REFERENCES template_versions (id) ON DELETE SET NULL,
        locale              text NOT NULL,
        recipient_email     text NOT NULL,
        -- Immutable snapshot of what was actually sent. Never regenerated from the template.
        subject             text NOT NULL,
        html                text NOT NULL,
        text                text NOT NULL,
        transport           text NOT NULL CHECK (transport IN ('log', 'unisender')),
        status              text NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued', 'sent', 'failed', 'suppressed')),
        provider_message_id text,
        provider_status     text,
        error               text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        sent_at             timestamptz
      );

      CREATE INDEX deliveries_created_idx ON deliveries (created_at DESC);
      CREATE INDEX deliveries_recipient_idx ON deliveries (lower(recipient_email));

      CREATE TABLE email_audit (
        id            uuid PRIMARY KEY,
        action        text NOT NULL,
        actor_user_id uuid,
        actor_role    text,
        details       jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at    timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX email_audit_created_idx ON email_audit (created_at DESC);
    `,
  },
  {
    version: 2,
    name: 'delivery-status-index',
    sql: `
      CREATE INDEX deliveries_status_idx ON deliveries (status, created_at DESC);
      CREATE INDEX template_versions_template_idx ON template_versions (template_id, locale, version DESC);
    `,
  },
  {
    version: 3,
    name: 'drop-suppressed-delivery-status',
    sql: `
      -- Whether to send at all is a routing decision, and Notifications makes it: it records a
      -- suppressed event and never calls Email. Nothing here could ever set this status, and a
      -- status no code can produce is a claim the schema cannot keep.
      ALTER TABLE deliveries DROP CONSTRAINT deliveries_status_check;
      ALTER TABLE deliveries ADD CONSTRAINT deliveries_status_check
        CHECK (status IN ('queued', 'sent', 'failed'));
    `,
  },
  {
    version: 4,
    name: 'one-language',
    sql: `
      -- Templates have one series of versions, not one per language. Multiple languages are a real
      -- feature, but not one a template can guess the shape of: a product that needs them adds the
      -- column back knowing how it chooses between them.
      DROP INDEX template_versions_published_idx;
      DROP INDEX template_versions_template_idx;
      ALTER TABLE template_versions DROP CONSTRAINT template_versions_template_id_locale_version_key;

      -- Keep one row per (template, version) whatever languages existed, preferring a published
      -- one and then the most recently touched. Matching only against a Russian row left
      -- duplicates behind on any installation that had other languages, and the constraints below
      -- then failed — inside the migration transaction, so the service restarted into the same
      -- failure forever.
      DELETE FROM template_versions v
       WHERE v.id NOT IN (
         SELECT DISTINCT ON (template_id, version) id
           FROM template_versions
          ORDER BY template_id, version,
                   (status = 'published') DESC,
                   updated_at DESC,
                   id
       );

      -- At most one published version per template, for the same reason.
      UPDATE template_versions SET status = 'archived'
       WHERE status = 'published'
         AND id NOT IN (
           SELECT DISTINCT ON (template_id) id
             FROM template_versions
            WHERE status = 'published'
            ORDER BY template_id, version DESC, id
         );

      ALTER TABLE template_versions DROP COLUMN locale;
      ALTER TABLE deliveries DROP COLUMN locale;

      ALTER TABLE template_versions ADD CONSTRAINT template_versions_template_id_version_key
        UNIQUE (template_id, version);
      CREATE UNIQUE INDEX template_versions_published_idx
        ON template_versions (template_id) WHERE status = 'published';
      CREATE INDEX template_versions_template_idx
        ON template_versions (template_id, version DESC);
    `,
  },
];
