/**
 * Types only — one value here and the `exports` key becomes a formality. `.output()` on every
 * procedure and the `satisfies` line are what keep this a projection rather than a promise.
 */
export type { NotificationsAdminRouter } from './routers.js';

/** What a neighbour holds to call this module: the caller, not the router. */
export type { NotificationsInternalCaller } from './index.js';

/** Inferred from `schemas.ts`: a Zod object is a value, and values must not cross this file. */
export type { NotificationEvent, StoredNotificationEvent } from './schemas.js';
