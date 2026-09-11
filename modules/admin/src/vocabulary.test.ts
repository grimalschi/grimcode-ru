import { describe, expect, it } from 'vitest';

import {
  validateCatalogue,
  adminModuleIdSchema,
} from './vocabulary.js';
import { paginationInputSchema } from './primitives.js';

describe('module ids', () => {
  it('allows a module named database without giving access to the owner-only screen', () => {
    expect(adminModuleIdSchema.safeParse('database').success).toBe(true);
  });

  it('validates installed metadata and rejects duplicates and invalid identifiers', () => {
    expect(validateCatalogue([{ id: 'billing', admin: { icon: 'app-window', title: 'Billing' } }])).toHaveLength(1);
    expect(validateCatalogue([{ id: 'database', admin: { icon: 'app-window', title: 'Database module' } }])).toHaveLength(1);
    expect(() => validateCatalogue([{ id: '../auth', admin: { icon: 'app-window', title: 'Auth' } }])).toThrow();
    expect(() => validateCatalogue([
      { id: 'billing', admin: { icon: 'app-window', title: 'First' } },
      { id: 'billing', admin: { icon: 'app-window', title: 'Second' } },
    ])).toThrow('Duplicate');
  });
});

describe('pagination', () => {
  it('applies safe defaults and an upper bound', () => {
    expect(paginationInputSchema.parse({})).toEqual({ limit: 25, offset: 0 });
    expect(paginationInputSchema.safeParse({ limit: 1000 }).success).toBe(false);
  });
});
