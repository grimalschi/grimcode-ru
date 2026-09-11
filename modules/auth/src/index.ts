import type { ModuleInstance } from '@template/contracts/module-instance';
import type { AuthApi } from '@template/contracts/modules/auth';
import type { NotificationsApi } from '@template/contracts/modules/notifications';

import { createAdminFetch } from './admin/index.js';
import { createDatabase } from './db/database.js';
import type { AuthEnv } from './env.js';
import { createInternalCaller } from './internal/index.js';
import { Notifier } from './notifier.js';
import { createPublicFetch } from './public/index.js';
import { AuthRepository } from './repository.js';

export type { AuthEnv } from './env.js';

/** Connect module-owned state to independently constructed entry surfaces. */
export function createModule({ env: settings, modules }: {
  env: AuthEnv;
  modules: { notifications: NotificationsApi };
}) {
  const env = { ...settings, sessionTtlSeconds: settings.sessionTtlSeconds ?? 30 * 24 * 60 * 60 };
  if (!Number.isSafeInteger(env.sessionTtlSeconds) || env.sessionTtlSeconds <= 0) {
    throw new Error('Auth sessionTtlSeconds must be a positive safe integer');
  }
  const database = createDatabase(env);
  const repository = async () => new AuthRepository(await database());
  const notifier = new Notifier(modules.notifications);

  return {
    id: 'auth',
    admin: { title: 'Auth', icon: 'key-round', assignable: true },
    publicFetch: createPublicFetch({ env, repository, notifier }),
    adminFetch: createAdminFetch({ env, repository, notifier }),
    internalCaller: createInternalCaller(repository),
    migrate: async () => { await database(); },
  } satisfies ModuleInstance<AuthApi>;
}
