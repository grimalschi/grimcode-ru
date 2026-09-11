import type { createDatabaseBrowser } from './admin/database/index.js';
import type { AuthApi } from '@template/contracts/modules/auth';
import type { CatalogueEntry } from './vocabulary.js';
import type { AdminRepository } from './repository.js';

/** Module-owned state shared by its administrative and internal surfaces. */
export interface ModuleContext {
  repo: AdminRepository;
  databaseBrowser: ReturnType<typeof createDatabaseBrowser>;
  auth: AuthApi;
  catalogue: readonly CatalogueEntry[];
}
