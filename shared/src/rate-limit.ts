/**
 * A fixed-window attempt counter.
 *
 * Deliberately in memory and deliberately small. It exists so that guessing one account's password
 * is not free, which is a per-service concern and belongs next to the check it protects. Volumetric
 * limits — requests per address, per network — belong at the edge proxy in front of Gateway, which
 * is the only thing that knows the real client address; see `docs/deployment.md`.
 *
 * Counting in memory means each instance counts on its own, so running two copies of a service
 * doubles the allowance. That is exact for the topology this template ships (one container per
 * service) and a deliberate trade against writing a row on every failed attempt.
 */
export interface RateLimiter {
  /** Records an attempt and answers whether it is still within the allowance. */
  attempt(key: string): boolean;
  /** Forgets a key, so a success does not leave the previous failures counting. */
  clear(key: string): void;
}

export interface RateLimitOptions {
  /** Attempts allowed inside one window. */
  limit: number;
  windowMs: number;
  /** Upper bound on tracked keys, so a flood of distinct keys cannot grow the map forever. */
  maxKeys?: number;
}

export function createRateLimiter({
  limit,
  windowMs,
  maxKeys = 10_000,
}: RateLimitOptions): RateLimiter {
  const windows = new Map<string, { count: number; expiresAt: number }>();

  const prune = (now: number): void => {
    for (const [key, window] of windows) {
      if (window.expiresAt <= now) windows.delete(key);
    }
  };

  return {
    attempt(key) {
      const now = Date.now();
      const current = windows.get(key);

      if (!current || current.expiresAt <= now) {
        if (windows.size >= maxKeys) prune(now);
        // Still full of live windows: the oldest insertion goes, which is the one closest to
        // expiring. Refusing to track is worse than losing the least recent count.
        if (windows.size >= maxKeys) {
          const oldest = windows.keys().next();
          if (!oldest.done) windows.delete(oldest.value);
        }

        windows.set(key, { count: 1, expiresAt: now + windowMs });
        return true;
      }

      current.count += 1;
      return current.count <= limit;
    },

    clear(key) {
      windows.delete(key);
    },
  };
}
