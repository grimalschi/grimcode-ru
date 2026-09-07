import { publicSiteUrl } from '@template/shared';

const NO_STORE = { 'cache-control': 'no-store' } as const;

function wantsHtml(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('text/html');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title: string, message: string, extra = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         background:#f6f7f9; color:#1b1f24; }
  main { max-width: 34rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1rem; color:#5b636c; }
  a { color:#1f6feb; }
  @media (prefers-color-scheme: dark) {
    body { background:#09090b; color:#fafafa; }
    p { color:#a1a1aa; }
    a { color:#8ab4f8; }
  }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${extra}</main></body>
</html>
`;
}

function respond(request: Request, status: number, code: string, title: string, message: string, extra = ''): Response {
  if (wantsHtml(request)) {
    return new Response(page(title, message, extra), {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE },
    });
  }
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE },
  });
}

/**
 * Every admin denial is a 403 — Gateway never leaks whether the refusal came from a missing
 * session, a missing grant or an owner-only service.
 */
export function forbidden(request: Request): Response {
  const signIn = `${publicSiteUrl()}/app/login`;
  return respond(
    request,
    403,
    'forbidden',
    'Access denied',
    'You do not have access to this part of the admin panel.',
    `<p><a href="${escapeHtml(signIn)}">Sign in with a different account</a></p>`,
  );
}

/** Admin registry is still empty because nobody has registered in Auth yet. */
export function awaitingFirstUser(request: Request): Response {
  return respond(
    request,
    403,
    'awaiting-first-user',
    'Admin panel is not initialised',
    'No user has registered yet. The first registered user becomes the owner.',
  );
}

export function notFound(request: Request): Response {
  return respond(request, 404, 'not-found', 'Not found', 'This address does not exist.');
}

/** Fail-closed: an authorization dependency is down, and that is not the same as "no rights". */
export function serviceUnavailable(request: Request): Response {
  return respond(
    request,
    503,
    'service-unavailable',
    'Temporarily unavailable',
    'The admin panel cannot verify access right now. Please try again shortly.',
  );
}

export function badGateway(request: Request): Response {
  return respond(request, 502, 'bad-gateway', 'Service unreachable', 'The service did not answer.');
}
