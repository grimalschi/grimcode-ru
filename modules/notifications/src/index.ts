import type { ModuleInstance } from '@template/contracts/module-instance';
import type { EmailApi } from '@template/contracts/modules/email';
import type { NotificationsApi } from '@template/contracts/modules/notifications';
import type { NotificationsEnv } from './env.js';
import { createDatabase } from './db/database.js';
import { NotificationsRepository } from './repository.js';
import { createAdminFetch } from './admin/index.js';
import { createInternalCaller } from './internal/index.js';

export type { NotificationsEnv } from './env.js';

/** Connects module-owned storage to independent administrative and internal surfaces. */
export function createModule({ env, modules }: {
  env: NotificationsEnv;
  modules: { email: EmailApi };
}) {
  const database = createDatabase(env);
  const repository = async () => new NotificationsRepository(await database());
  return {
    id: 'notifications',
    admin: { title: 'Notifications', icon: 'bell', assignable: true },
    adminFetch: createAdminFetch({ env, repository }),
    internalCaller: createInternalCaller(async () => ({
      repo: await repository(),
      email: modules.email,
    })),
    migrate: async () => { await database(); },
  } satisfies ModuleInstance<NotificationsApi>;
}
