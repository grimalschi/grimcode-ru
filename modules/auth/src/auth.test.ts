import { verifyPassword } from '@template/shared';
import { describe, expect, it } from 'vitest';

import { assertOpenedDatabase, openOnce, type Pool } from './db/database.js';
import { DUMMY_PASSWORD_HASH } from './routers/public.js';

// The cookie itself is `shared`'s: Auth is not the only surface that ends a session. Its checks
// live next to it, in `shared/src/shared.test.ts`.
//
// The session lifetime used to be checked here, while Auth still read `AUTH_SESSION_TTL_SECONDS`
// itself. It is the composer's to read now, and the defaults are pinned in
// the entry's own `index.test.ts`.

describe('this module opening its own database', () => {
  /**
   * Two requests arriving together share one attempt. Remembering the pool instead of the promise
   * would let both prepare the database — create it, migrate it — twice over.
   */
  it('prepares once for requests that arrive together', async () => {
    let attempts = 0;
    const open = openOnce(async () => {
      attempts += 1;
      await Promise.resolve();
      return 'pool';
    });

    expect(await Promise.all([open(undefined), open(undefined), open(undefined)])).toEqual([
      'pool',
      'pool',
      'pool',
    ]);
    expect(attempts).toBe(1);
  });

  /**
   * A failure is not remembered. Nothing waits for PostgreSQL before the application starts any more,
   * so the first request can arrive before the server is up — remembering that would refuse every
   * later request until the process is restarted.
   */
  it('tries again after a failure, then remembers the success', async () => {
    let attempts = 0;
    const open = openOnce(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('the server is not up yet');
      return 'pool';
    });

    await expect(open(undefined)).rejects.toThrow(/not up yet/);
    expect(await open(undefined)).toBe('pool');
    expect(await open(undefined)).toBe('pool');
    expect(attempts).toBe(2);
  });

  /**
   * The check that stands between a mistyped `DATABASE_URL_AUTH` and this module's tables being
   * created in somebody else's database. Nothing else does: the credentials open every database.
   */
  it('refuses a pool that landed on another database', async () => {
    const landedOn = (name: string) =>
      ({ query: async () => ({ rows: [{ current_database: name }] }) }) as unknown as Pool;

    await expect(assertOpenedDatabase(landedOn('demo_auth'), 'demo_auth')).resolves.toBeUndefined();
    await expect(assertOpenedDatabase(landedOn('demo_users'), 'demo_auth')).rejects.toThrow(
      /demo_users/,
    );
  });
});

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
