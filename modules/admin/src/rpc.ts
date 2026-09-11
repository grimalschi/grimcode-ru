/**
 * How long a caller waits for a neighbour. A budget, not a detail: whatever the neighbour does on the
 * way to answering has to fit inside it, or the caller records a failure for work that succeeded.
 */
export const RPC_TIMEOUT_MS = 10_000;

/** Error a call gets when the neighbour did not answer within the deadline. */
class RpcTimeoutError extends Error {
  constructor(
    readonly procedure: string,
    readonly timeoutMs: number,
  ) {
    super(`Call to ${procedure} did not answer within ${timeoutMs} ms`);
    this.name = 'RpcTimeoutError';
  }
}

/** Stops waiting after the deadline; the underlying procedure continues independently. */
async function withDeadline<T>(
  work: Promise<T> | T,
  procedure: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RpcTimeoutError(procedure, timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Puts the deadline on every procedure of a caller, so no call site has to remember it — the module
 * that hands the caller out is what guarantees the wait ends.
 *
 * Only flat routers: a nested one would need this applied to each sub-router, and none of ours nests.
 */
export function withDeadlineOn<TCaller extends object>(
  caller: TCaller,
  label: string,
  timeoutMs: number,
): TCaller {
  return new Proxy(caller, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;

      return (...args: unknown[]) =>
        withDeadline(
          (value as (...called: unknown[]) => Promise<unknown>).apply(target, args),
          `${label}.${String(property)}`,
          timeoutMs,
        );
    },
  }) as TCaller;
}
