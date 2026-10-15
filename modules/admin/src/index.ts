import { createDatabaseBrowser } from './admin/database/index.js';
import type { AuthApi } from '@template/contracts/modules/auth';
import type { AdminApi } from '@template/contracts/modules/admin';
import type { ModuleInstance } from '@template/contracts/module-instance';
import type { AdminEnv } from './env.js';
import { createDatabase } from './db/database.js';
import { AdminRepository } from './repository.js';
import { validateCatalogue, type CatalogueEntry } from './vocabulary.js';
import { createAdminFetch } from './admin/index.js';
import { ownersAbleToSignIn } from './admin/router.js';
import { createInternalCaller } from './internal/index.js';

export type { AdminEnv } from './env.js';

/** Shares module-owned state, then connects independently constructed surfaces. */
export function createModule({ env, modules, catalogue: installed }: {
  env: AdminEnv;
  modules: { auth: AuthApi };
  catalogue: readonly CatalogueEntry[];
}) {
  const catalogue = validateCatalogue(installed);
  const database = createDatabase(env);
  // The editor asks Auth the registry screen's question about the remaining owners, through the same helper.
  const databaseBrowser = createDatabaseBrowser(database, {
    ownersAbleToSignIn: (userIds) => ownersAbleToSignIn(userIds, modules.auth),
  });
  const context = async () => ({
    repo: new AdminRepository(await database()),
    auth: modules.auth,
    catalogue,
    databaseBrowser,
  });
  return {
    id: 'admin',
    adminFetch: createAdminFetch({ env, context }),
    internalCaller: createInternalCaller(context),
    migrate: async () => {
      await database();
      // Every owner carries Auth's protection from blocking. Set with the role from now on; asked
      // for here on each start so an installation that predates the mark, or a hand-edited
      // database, catches up. Auth writes nothing when the mark is already there.
      const repo = new AdminRepository(await database());
      for (const row of await repo.list()) {
        if (row.role !== 'owner') continue;
        await modules.auth.setBlockingProtection({ userId: row.user_id, protected: true, actor: { userId: row.user_id, role: 'owner' } });
      }
    },
  } satisfies ModuleInstance<AdminApi>;
}
