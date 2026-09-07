/**
 * Types only. A leak would hurt most here: `@maily-to/render` is the one CPU-bound dependency in the
 * process, and a neighbour must not reach it by following a type. `.output()` on every procedure is
 * what keeps this honest.
 */
export type { EmailAdminRouter } from './routers.js';

/** What a neighbour holds to call this module: the caller, not the router. */
export type { EmailInternalCaller } from './index.js';

/** The document the editor stores. A Zod object is a value, so the inferred type crosses instead. */
export type { EditorDocument } from './schemas.js';
