export const migration = {
  version: 2,
  name: 'redact-account-links',
  // Old events are never replayed. Remove their credential URLs altogether; retain event metadata.
  sql: `
    UPDATE events
    SET payload = payload || (
      SELECT jsonb_object_agg(key, '[redacted]'::text)
      FROM jsonb_each(payload)
      WHERE key IN ('verificationUrl', 'resetUrl', 'confirmUrl')
    )
    WHERE payload ?| ARRAY['verificationUrl', 'resetUrl', 'confirmUrl'];
  `,
};
