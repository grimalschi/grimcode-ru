import { migration as version1 } from './001-identities-sessions-tokens-audit.js';
import { migration as version2 } from './002-blocking-protection.js';

export const migrations = [version1, version2];
