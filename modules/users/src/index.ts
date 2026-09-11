import type { ModuleInstance } from '@template/contracts/module-instance';
import type { AuthApi } from '@template/contracts/modules/auth';

import { createAdminFetch } from './admin/index.js';
import { createDatabase } from './db/database.js';
import type { UsersEnv } from './env.js';
import { createPublicFetch } from './public/index.js';
import { UsersRepository } from './repository.js';

export type { UsersEnv } from './env.js';

/** Compose the module's separately built entry surfaces around its own lazy repository. */
export function createModule({ env, modules }: {
  env: UsersEnv;
  modules: { auth: AuthApi };
}) {
  const database = createDatabase(env);
  const repository = async () => new UsersRepository(await database());

  return {
    id: 'users',
    admin: { title: 'Users', icon: 'users', assignable: true },
    publicFetch: createPublicFetch({ env, repository, auth: modules.auth }),
    adminFetch: createAdminFetch({ env, repository, auth: modules.auth }),
    migrate: async () => { await database(); },
  } satisfies ModuleInstance;
}
