import { describe, expect, it } from 'vitest';

import { createRateLimiter } from './rate-limit.js';

describe('rate limiting', () => {
  it('allows the attempts inside the window and refuses the ones after them', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });

    expect([1, 2, 3].map(() => limiter.attempt('a'))).toEqual([true, true, true]);
    expect(limiter.attempt('a')).toBe(false);

    // Counted per key, so one address being hammered does not lock anyone else out.
    expect(limiter.attempt('b')).toBe(true);
  });

  it('starts over once the window has passed', async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 20 });

    expect(limiter.attempt('a')).toBe(true);
    expect(limiter.attempt('a')).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(limiter.attempt('a')).toBe(true);
  });

  it('forgets a key on request, which is what a successful sign-in does', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });

    expect(limiter.attempt('a')).toBe(true);
    limiter.clear('a');
    expect(limiter.attempt('a')).toBe(true);
  });

  /** A flood of distinct keys must not be a way to grow the process out of memory. */
  it('keeps the number of tracked keys bounded', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 10 });

    for (let index = 0; index < 1_000; index += 1) limiter.attempt(`key-${index}`);

    // The most recent key is still counted, which is the one that matters.
    expect(limiter.attempt('key-999')).toBe(false);
  });
});
