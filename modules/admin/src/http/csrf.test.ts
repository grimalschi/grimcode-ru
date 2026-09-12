import { describe, expect, it } from 'vitest';
import { isCsrfValid } from './csrf.js';

describe('CSRF token validation', () => {
  it('requires the literal CSRF header and this surface’s cookie to match', () => {
    const headers = new Headers({
      cookie: 'installation_csrf_admin=token-value; installation_csrf_other=other-value',
      'x-csrf-token': 'token-value',
    });
    expect(isCsrfValid(headers, 'installation_csrf_admin')).toBe(true);
    expect(isCsrfValid(headers, 'installation_csrf_other')).toBe(false);
    headers.set('x-csrf-token', 'short');
    expect(isCsrfValid(headers, 'installation_csrf_admin')).toBe(false);
    headers.delete('x-csrf-token');
    expect(isCsrfValid(headers, 'installation_csrf_admin')).toBe(false);
  });
});
