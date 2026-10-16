import { migration as version1 } from './001-templates-versions-deliveries.js';
import { migration as version2 } from './002-audit-actor-email.js';

export const migrations = [version1, version2];
