/**
 * Who did it, as an address. Accounts live in Auth and Email never asks it; the panel hands the
 * acting administrator's address with every request, so the entry keeps the one it had at the time.
 * Entries written before this have none.
 */
export const migration = {
  version: 2,
  name: 'audit-actor-email',
  sql: `
      ALTER TABLE email_audit ADD COLUMN actor_email text;
  `,
};
