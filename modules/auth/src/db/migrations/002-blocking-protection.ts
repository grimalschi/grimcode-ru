/**
 * An identity the panel protects from blocking — its owners. Admin sets and clears the mark as the
 * owner role comes and goes; Auth itself refuses to block a protected identity. The rule lives in
 * data, not in a call: Auth never asks Admin anything.
 */
export const migration = {
  version: 2,
  name: 'blocking-protection',
  sql: `
      ALTER TABLE identities ADD COLUMN blocking_protected_at timestamptz;
  `,
};
