import { describe, expect, it } from 'vitest';

import { toProfile, type ProfileRow } from './repository.js';

const row: ProfileRow = {
  id: '00000000-0000-4000-8000-000000000001',
  identity_id: '00000000-0000-4000-8000-000000000002',
  display_name: 'Ada',
  time_zone: 'Europe/Berlin',
  locale: 'en',
  theme: 'system',
  product_emails: true,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-02T00:00:00.000Z'),
};

describe('profile mapping', () => {
  it('groups preferences into their own object', () => {
    expect(toProfile(row).preferences).toEqual({ locale: 'en', theme: 'system', productEmails: true });
  });


  it('exposes the identity link without pretending to own the identity', () => {
    const profile = toProfile(row);
    expect(profile.identityId).toBe(row.identity_id);
    expect(profile).not.toHaveProperty('email');
    expect(profile).not.toHaveProperty('passwordHash');
  });
});
