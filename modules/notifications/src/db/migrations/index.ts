import { migration as version1 } from './001-events.js';
import { migration as version2 } from './002-redact-account-links.js';

export const migrations = [version1, version2];
