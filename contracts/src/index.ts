/**
 * Re-exported so a service can derive a typed client from a contract without depending on the
 * oRPC contract package directly.
 */
export type { ContractRouterClient } from '@orpc/contract';

export * from './common.js';
export * from './auth.js';
export * from './admin.js';
export * from './users.js';
export * from './notifications.js';
export * from './email.js';
