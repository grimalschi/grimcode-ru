import type { Migration } from '@template/shared';

/**
 * Versioned migrations of the Email database.
 *
 * The template starts at one migration on purpose: this is the schema a new project inherits, not a
 * record of how it was arrived at. Every change after the first clone is a new version, and a
 * released version is never edited — the migrator refuses a changed checksum.
 */
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

      -- One series of versions per template. Several languages are a real feature, but not one a
      -- template can guess the shape of: a product that needs them adds the column knowing how it
      -- chooses between them.
      CREATE TABLE template_versions (
        id              uuid PRIMARY KEY,
        template_id     uuid NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
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
        UNIQUE (template_id, version)
      );

      -- At most one published version per template, so runtime delivery is never ambiguous about
      -- which content it must send.
      CREATE UNIQUE INDEX template_versions_published_idx
        ON template_versions (template_id) WHERE status = 'published';
      CREATE INDEX template_versions_template_idx
        ON template_versions (template_id, version DESC);

      CREATE TABLE deliveries (
        id                  uuid PRIMARY KEY,
        -- Idempotency key of the caller; the unique index is what prevents a double send.
        dedupe_key          text NOT NULL UNIQUE,
        template_key        text NOT NULL,
        template_version_id uuid REFERENCES template_versions (id) ON DELETE SET NULL,
        recipient_email     text NOT NULL,
        -- Immutable snapshot of what was actually sent. Never regenerated from the template.
        subject             text NOT NULL,
        html                text NOT NULL,
        text                text NOT NULL,
        transport           text NOT NULL CHECK (transport IN ('log', 'unisender')),
        -- Whether to send at all is a routing decision and Notifications makes it: it records a
        -- suppressed event and never calls Email. There is no status here for that, because
        -- nothing here could ever set it.
        status              text NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued', 'sent', 'failed')),
        provider_message_id text,
        provider_status     text,
        error               text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        sent_at             timestamptz
      );

      CREATE INDEX deliveries_created_idx ON deliveries (created_at DESC);
      CREATE INDEX deliveries_recipient_idx ON deliveries (lower(recipient_email));
      CREATE INDEX deliveries_status_idx ON deliveries (status, created_at DESC);

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
];
