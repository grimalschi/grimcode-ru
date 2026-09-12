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
 * Module handlers receive the original address and body.
 */
export async function proxyRequest(request: Request, { target }: {
  target: HttpHandler;
}): Promise<Response> {

  const headers = new Headers(request.headers);

  for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);
  headers.delete('host');
  headers.delete('content-length');

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
