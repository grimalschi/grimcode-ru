export const migration = {
  version: 1,
  name: 'administrators-grants-audit',
  sql: `
      CREATE TABLE administrators (
        id         uuid PRIMARY KEY,
        user_id    uuid NOT NULL UNIQUE,
        email      text NOT NULL,
        role       text NOT NULL CHECK (role IN ('owner', 'admin')),
        -- Administrators are never deleted; history is kept by disabling them.
        enabled    boolean NOT NULL DEFAULT true,
        -- Marks the single administrator created by the first-owner bootstrap.
        bootstrap  boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      -- Two concurrent bootstrap requests cannot produce two bootstrap owners.
      CREATE UNIQUE INDEX administrators_single_bootstrap_idx
        ON administrators ((bootstrap)) WHERE bootstrap;

      CREATE TABLE administrator_grants (
        administrator_id uuid NOT NULL REFERENCES administrators (id) ON DELETE CASCADE,
        module           text NOT NULL,
        granted_at       timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (administrator_id, module)
      );

      CREATE TABLE admin_audit (
        id              uuid PRIMARY KEY,
        action          text NOT NULL,
        actor_user_id   uuid,
        subject_user_id uuid,
        details         jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at      timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX admin_audit_created_idx ON admin_audit (created_at DESC);

      CREATE INDEX administrators_role_enabled_idx ON administrators (role, enabled);
      CREATE INDEX administrators_email_lower_idx ON administrators (lower(email));
    `,
};
