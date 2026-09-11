import type { Pool } from './database.js';
import { renderMessage } from '../render.js';
import { EmailRepository } from '../repository.js';

/** Create missing Auth templates as complete published versions. */
export function seedTemplates(pool: Pool): Promise<number> {
  return new EmailRepository(pool).ensureSeedTemplates(renderMessage);
}
