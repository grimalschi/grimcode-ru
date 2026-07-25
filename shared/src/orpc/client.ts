import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';

export interface RpcClientOptions {
  /** Absolute URL of the RPC mount, for example `http://auth:3003/internal/rpc`. */
  url: string;
  /** Extra headers sent with every call, such as the propagated request id. */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Typed oRPC client.
 *
 * The caller supplies the client type derived from a contract, for example
 * `ContractRouterClient<typeof authInternalContract>`, so a call site can never drift from the
 * contract it targets.
 */
export function createRpcClient<T>(options: RpcClientOptions): T {
  const link = new RPCLink({
    url: options.url,
    headers: () => options.headers ?? {},
    fetch: (request, init) =>
      fetch(request, {
        ...init,
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      }),
  });
  return createORPCClient(link) as T;
}

/**
 * Error thrown when a dependency of an authorization decision is unreachable.
 *
 * Callers must translate it into a fail-closed service-unavailable response instead of hiding an
 * infrastructure failure behind "no rights".
 */
export class ServiceUnavailableError extends Error {
  constructor(
    readonly service: string,
    readonly reason: unknown,
  ) {
    super(`Service ${service} is unavailable`);
    this.name = 'ServiceUnavailableError';
  }
}
