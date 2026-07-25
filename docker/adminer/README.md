# Adminer

Real Adminer `5.4.2-standalone` image with the complete copied reference stylesheet and a
neutralized PHP wrapper. It reads `DATABASE_URL` or explicit connection-level
`TEMPLATE_ADMINER_*` overrides, has no host port, and is reachable only through Gateway's
owner-only route. The wrapper connects at PostgreSQL server level and lets Adminer discover
available databases; it does not contain a service-to-database registry.

The wrapper keeps the reference DOM adjustments used by the stylesheet, including the current-page
pagination marker. It also applies central Admin's light, dark or system theme through the
same-origin frame bridge. Its selectors and bridge must be browser-tested whenever the pinned
Adminer image is updated.

## Router script

Gateway forwards paths unchanged, so Adminer is reached at `/admin/service/adminer/**`. The base
image starts PHP's built-in server with a document root only, which answers 404 for any such path.
The Dockerfile therefore passes `index.php` as the server's router script, so every request reaches
the wrapper — which already reads `REQUEST_URI` and serves `adminer.css` by basename. This is
project configuration only: the wrapper, its DOM transformations and the stylesheet are unchanged.

Gradients, translucent surfaces, sticky footers and controls use semantic light/dark tokens.
Browser acceptance checks their computed colors on both the database overview and a real table;
checking only the root theme attribute does not prove that the theme is complete.
