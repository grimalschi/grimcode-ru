import { describe, expect, it } from 'vitest';

import { readAdminContext } from './admin-context.js';

/** Literal wire values: importing Router's implementation would hide accidental protocol changes. */
const verifiedHeaders = {
  'x-template-admin-user-id': '00000000-0000-4000-8000-000000000000',
  'x-template-admin-email': 'owner@example.test',
  'x-template-admin-role': 'owner',

};

describe('users administrator protocol', () => {
  it.each(['owner', 'admin'] as const)('accepts a complete verified %s context', (role) => {
    const headers = new Headers({ ...verifiedHeaders, 'x-template-admin-role': role });
    expect(readAdminContext(headers)).toEqual({
      userId: '00000000-0000-4000-8000-000000000000',
      email: 'owner@example.test',
      role,
    });
  });

  it('denies a context missing any required control header', () => {
    expect(readAdminContext(new Headers())).toBeNull();
    for (const name of Object.keys(verifiedHeaders)) {
      const headers = new Headers(verifiedHeaders);
      headers.delete(name);
      expect(readAdminContext(headers), name).toBeNull();
    }
  });

  it.each([
    ['x-template-admin-user-id', 'not-a-uuid'],
    ['x-template-admin-email', 'not-an-email'],
    ['x-template-admin-role', 'superadmin'],
  ])('denies malformed %s', (name, value) => {
    const headers = new Headers(verifiedHeaders);
    headers.set(name, value);
    expect(readAdminContext(headers)).toBeNull();
  });
});
