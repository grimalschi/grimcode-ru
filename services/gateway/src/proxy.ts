import type { AdminContext } from '@template/contracts';
import { applyAdminContext, REQUEST_ID_HEADER, stripAdminContextHeaders } from '@template/shared';

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

export interface ProxyOptions {
  targetBaseUrl: string;
  requestId: string;
  /** Present only after Admin allowed an `/admin/**` request. */
  adminContext?: AdminContext;
}

/**
 * Forwards a request to a service without rewriting its path.
 *
 * The service receives exactly the address the browser asked for — `/admin/embed/service/email/...`
 * arrives at Email as `/admin/embed/service/email/...`.
 */
export async function proxyRequest(request: Request, options: ProxyOptions): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(options.targetBaseUrl);
  target.pathname = incoming.pathname;
  target.search = incoming.search;

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

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : null,
    // A service's own redirect — Adminer's first response is one — belongs to the browser.
    redirect: 'manual',
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit & { duplex?: 'half' });

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
