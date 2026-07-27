import { describe, expect, it } from 'vitest';

import { toProfile, type ProfileRow } from './repository.js';

const row: ProfileRow = {
  id: '00000000-0000-4000-8000-000000000001',
  identity_id: '00000000-0000-4000-8000-000000000002',
  display_name: 'Ada',
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-02T00:00:00.000Z'),
};

describe('profile mapping', () => {
  it('carries the display name', () => {
    expect(toProfile(row).displayName).toBe('Ada');
  });

  /**
   * The address belongs to Auth. A profile that carried it would be a second copy to keep in step,
   * and the first one to go stale.
   */
  it('exposes the identity link without pretending to own the identity', () => {
    const profile = toProfile(row);
    expect(profile.identityId).toBe(row.identity_id);
    expect(profile).not.toHaveProperty('email');
    expect(profile).not.toHaveProperty('passwordHash');
  });
});
