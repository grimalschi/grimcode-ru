import type { AuthEnv } from './env.js';
import type { Notifier } from './notifier.js';
import type { AuthRepository } from './repository.js';

/** Module-owned state passed only to the surface that needs it. */
export interface HttpDependencies {
  env: Required<AuthEnv>;
  repository: () => Promise<AuthRepository>;
  notifier: Notifier;
}
