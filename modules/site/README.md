# Site

The public website, rendered on the server so visitors and crawlers receive complete HTML.
Pages live in [`src/routes`](src/routes): landing, about, contact, terms and privacy.
The root route supplies default metadata; unknown pages return HTTP 404.

[`createModule({ env: { origin } })`](server/index.mjs) returns `publicFetch`.
Composition supplies `PUBLIC_SITE_URL` as `origin`; [`server/public.mjs`](server/public.mjs)
uses it to generate `robots.txt` and `sitemap.xml`, serves static assets and passes page requests
to the SSR handler. Hashed assets are cached for a year; other static files for five minutes.

The build generates `dist/server/server.js`, imported by `server/public.mjs`. This adapter disables
the import-boundary rule locally so lint also works before a build; review its imports when changing it.

## Adapting the template

Replace the example content and metadata with the product's own. Fill in the terms and privacy
pages before publication, then remove their `noindex` metadata and add them to `SITEMAP` in
[`server/public.mjs`](server/public.mjs). The initial sitemap lists `/`, `/about` and `/contact`.

For the Site Vite server, run `pnpm --filter @template/site dev`. Use the
[development instructions](../../docs/development.md) to run the complete application.
