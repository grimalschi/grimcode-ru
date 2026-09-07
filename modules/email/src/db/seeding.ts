
import type { Pool } from '@template/shared';

import { renderMessage } from '../render.js';
import { EmailRepository } from '../repository.js';

/**
 * Creates the seed templates, already published, so the auth flows work on a fresh installation. Never
 * overwrites an existing one, so running it twice changes nothing.
 *
 * Called from `db/database.ts` after the migrations. Its own file, not `seed.ts` beside the documents: the
 * repository reads that one, and the two would import each other.
 *
 * Costs a render of every template through `@maily-to/render` — once per fresh database, paid by the
 * first request that reaches this module.
 */
export async function seedTemplates(deps: { pool: Pool }): Promise<number> {
  const repo = new EmailRepository(deps.pool);

  const seeded = await repo.ensureSeedTemplates((editorDocument, subject) =>
    renderMessage(editorDocument, subject).then(({ html, text }) => ({ html, text })),
  );

  return seeded;
}
