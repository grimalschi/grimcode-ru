/** The independently built SSR module, configured once by composition. */
import type { ModuleInstance } from '@template/contracts/module-instance';

export declare function createModule(
  options: { env: { origin: string } },
): Pick<Required<ModuleInstance>, 'id' | 'publicFetch'>;
