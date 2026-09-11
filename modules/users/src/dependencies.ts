import type { AuthApi } from '@template/contracts/modules/auth';
import type { UsersEnv } from './env.js';
import type { UsersRepository } from './repository.js';

/** Already configured module state used by the independent HTTP surfaces. */
export interface HttpDependencies {
  env: UsersEnv;
  repository: () => Promise<UsersRepository>;
  auth: AuthApi;
}
