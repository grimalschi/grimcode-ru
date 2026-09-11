// @ts-check
import { createPublicFetch } from './public.mjs';

/**
 * @param {{ env: { origin: string } }} options
 */
export function createModule({ env }) {
  return /** @satisfies {import('@template/contracts/module-instance').ModuleInstance} */ ({
    id: 'site',
    publicFetch: createPublicFetch(env),
  });
}
