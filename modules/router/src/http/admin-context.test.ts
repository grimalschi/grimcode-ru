import { describe, expect, it } from 'vitest';

import { applyAdminContext, stripAdminContextHeaders } from './admin-context.js';

describe('administrator header convention', () => {
  it('removes all client-supplied control headers before authorization', () => {
    const headers = new Headers({
      'x-template-admin-user-id': 'forged',
      'x-template-admin-email': 'attacker@example.test',
      'x-template-admin-role': 'owner',
      cookie: 'installation_session=session',
    });

    stripAdminContextHeaders(headers);

    expect([...headers.entries()]).toEqual([['cookie', 'installation_session=session']]);
  });

  it('writes the verified context under the exact headers each module validates', () => {
    const headers = new Headers();
    applyAdminContext(headers, {
      userId: '00000000-0000-4000-8000-000000000000',
      email: 'owner@example.test',
      role: 'owner',
    });

    expect(Object.fromEntries(headers)).toEqual({
      'x-template-admin-user-id': '00000000-0000-4000-8000-000000000000',
      'x-template-admin-email': 'owner@example.test',
      'x-template-admin-role': 'owner',
    });
  });
});
