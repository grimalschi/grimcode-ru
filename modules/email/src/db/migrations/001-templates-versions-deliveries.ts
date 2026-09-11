export const migration = {
  version: 1,
  name: 'templates-versions-deliveries',
  sql: `
      CREATE TABLE templates (
        id          uuid PRIMARY KEY,
        key         text NOT NULL UNIQUE,
        name        text NOT NULL,
        description text,
        variables   jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE template_versions (
        id              uuid PRIMARY KEY,
        template_id     uuid NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
        version         integer NOT NULL,
        status          text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'archived')),
        subject         text NOT NULL,
        source          text NOT NULL,
        -- Compiled on publication and used for delivery.
        compiled_html   text,
        compiled_text   text,
        published_at    timestamptz,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (template_id, version)
      );

      CREATE UNIQUE INDEX template_versions_published_idx
        ON template_versions (template_id) WHERE status = 'published';
      CREATE INDEX template_versions_template_idx
        ON template_versions (template_id, version DESC);

      CREATE TABLE deliveries (
        id                  uuid PRIMARY KEY,
        -- Reserves a send before contacting the provider.
        dedupe_key          text NOT NULL UNIQUE,
        template_key        text NOT NULL,
        template_version_id uuid REFERENCES template_versions (id) ON DELETE SET NULL,
        recipient_email     text NOT NULL,
        -- Message snapshot with one-time tokens redacted.
        subject             text NOT NULL,
        html                text NOT NULL,
        text                text NOT NULL,
        transport           text NOT NULL CHECK (transport IN ('log', 'unisender')),
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
};
