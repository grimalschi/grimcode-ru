import type { EmailRepository } from './repository.js';
import type { Transport } from './transport.js';

/** The admin editor and internal delivery share this module's storage and transport. */
export interface ModuleContext {
  repo: EmailRepository;
  transport: Transport;
}
