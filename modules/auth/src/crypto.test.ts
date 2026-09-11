import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './crypto.js';

describe('passwords', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong horse battery', hash)).toBe(false);
  });

  it('produces a different hash for the same password', async () => {
    expect(await hashPassword('same password 123')).not.toBe(await hashPassword('same password 123'));
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });

});
