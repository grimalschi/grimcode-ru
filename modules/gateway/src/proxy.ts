import type { AdminContext } from '@template/shared/vocabulary';
import {
  applyAdminContext,
  REQUEST_ID_HEADER,
  stripAdminContextHeaders,
  type FetchLike,
} from '@template/shared';

/**
 * Headers that describe a single network hop and must never be forwarded.
 * `transfer-encoding` and `content-length` are re-derived by the runtime for the new hop.
 */
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD']);

/**
 * Where a request goes: an application living in this process, reached by call rather than over a
 * socket. Every target is one of these now — the database browser in its own container was the last
 * real address, and nothing in the process dials outwards any more.
 */
export type ProxyTarget = FetchLike;

export interface ProxyOptions {
  target: ProxyTarget;
  requestId: string;
  /** Present only after Admin allowed an `/admin/**` request. */
  adminContext?: AdminContext;
}

/**
 * Forwards a request to its target without rewriting its path.
 *
 * The module receives exactly the address the browser asked for: routing has always gone by path,
 * and a module in this process reads the path off the very same `Request`.
 *
 * The administrator context still travels as headers rather than as an argument, and that keeps
 * `access.test.ts` meaningful: the check that a forged `x-template-admin-*` buys nothing only means
 * something while that is how the context arrives.
 */
export async function proxyRequest(request: Request, options: ProxyOptions): Promise<Response> {
  const incoming = new URL(request.url);

  const headers = new Headers(request.headers);

  // The client must never be able to supply the administrator context. It is removed here, before
  // any decision is made, and written again only from a verified result.
  stripAdminContextHeaders(headers);

  for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);
  headers.delete('host');
  headers.delete('content-length');

  // The proxy runtime decodes compressed responses transparently, so asking upstream for a
  // compressed body would only produce headers that no longer describe the body we forward.
  headers.set('accept-encoding', 'identity');

  headers.set('x-forwarded-host', incoming.host);
  headers.set('x-forwarded-proto', incoming.protocol.replace(':', ''));

  if (options.adminContext) applyAdminContext(headers, options.adminContext);
  else headers.set(REQUEST_ID_HEADER, options.requestId);

  const hasBody = !METHODS_WITHOUT_BODY.has(request.method.toUpperCase());

  const init = {
    method: request.method,
    headers,
    body: hasBody ? request.body : null,
    // A target's own redirect belongs to the browser, not to us.
    redirect: 'manual',
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit & { duplex?: 'half' };

  const upstream = await options.target(new Request(incoming, init));

  const responseHeaders = new Headers(upstream.headers);

  // Whatever the upstream claimed about encoding no longer describes the body being forwarded.
  responseHeaders.delete('content-encoding');
  responseHeaders.delete('content-length');
  for (const header of HOP_BY_HOP_HEADERS) responseHeaders.delete(header);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
