import type { AdminContext } from '@template/contracts/modules/admin';
import { applyAdminContext, stripAdminContextHeaders } from './http/admin-context.js';
import type { HttpHandler } from './registry.js';

/**
 * Headers that describe a single network hop and must never be forwarded.
 * The outer HTTP server owns connection framing.
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

/**
 * Forwards a request to its target without rewriting its path.
 *
 * Module handlers receive the original address and only verified administrator context headers.
 */
export async function proxyRequest(request: Request, { target, adminContext }: {
  target: HttpHandler;
  /** Present only after Admin allowed an `/admin/**` request. */
  adminContext?: AdminContext;
}): Promise<Response> {

  const headers = new Headers(request.headers);

  // The client must never be able to supply the administrator context. It is removed here, before
  // any decision is made, and written again only from a verified result.
  stripAdminContextHeaders(headers);

  for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);
  headers.delete('host');
  headers.delete('content-length');

  if (adminContext) applyAdminContext(headers, adminContext);

  const upstream = await target(new Request(request, { headers }));

  const responseHeaders = new Headers(upstream.headers);

  // A direct handler call leaves the body and its content encoding unchanged.
  responseHeaders.delete('content-length');
  for (const header of HOP_BY_HOP_HEADERS) responseHeaders.delete(header);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
