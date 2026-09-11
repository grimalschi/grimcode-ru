import type { ModuleInstance } from '@template/contracts/module-instance';
import type { EmailApi } from '@template/contracts/modules/email';
import type { EmailEnv } from './env.js';
import { createDatabase } from './db/database.js';
import { EmailRepository } from './repository.js';
import { createTransport } from './transport.js';
import { createAdminFetch } from './admin/index.js';
import { createInternalCaller } from './internal/index.js';

export type { EmailEnv } from './env.js';
export type { MailSettings } from './transport.js';

/** Storage and transport are shared inside Email; each surface constructs its own entry point. */
export function createModule({ env }: { env: EmailEnv }) {
  const database = createDatabase(env);
  const transport = createTransport(env.mail);
  const context = async () => ({
    repo: new EmailRepository(await database()),
    transport,
  });
  return {
    id: 'email',
    admin: { title: 'Email', icon: 'mail', assignable: true },
    adminFetch: createAdminFetch({ env, context }),
    internalCaller: createInternalCaller(context),
    migrate: async () => { await database(); },
  } satisfies ModuleInstance<EmailApi>;
}
