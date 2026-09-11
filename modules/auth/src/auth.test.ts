import { verifyPassword } from './crypto.js';
import { describe, expect, it } from 'vitest';

import { DUMMY_PASSWORD_HASH } from './public/router.js';

describe('login timing defence', () => {
  /**
   * When no identity matches, login still verifies this fixed hash so that a wrong address and a
   * wrong password take comparable time. If it ever stopped being a parseable hash, the work would
   * be skipped and login would become an existence oracle again.
   */
  it('is a parseable hash that never matches and never throws', async () => {
    await expect(verifyPassword('anything at all', DUMMY_PASSWORD_HASH)).resolves.toBe(false);
    await expect(verifyPassword('', DUMMY_PASSWORD_HASH)).resolves.toBe(false);
  });

  it('costs real work rather than returning early on a malformed value', async () => {
    const [scheme, salt, key] = DUMMY_PASSWORD_HASH.split('$');
    expect(scheme).toBe('scrypt');
    expect(salt).toHaveLength(32);
    expect(key).toHaveLength(128);
  });
});
