/**
 * Node entry for the server-rendered site.
 *
 * The framework's build produces a fetch handler, not a listening server, so that the same output
 * can be hosted on different runtimes. This file is the one line of hosting the template needs: it
 * serves that handler over HTTP on the internal port Gateway proxies to.
 */
import { serve } from '@hono/node-server';

import entry from '../dist/server/server.js';

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: entry.fetch, port, hostname: '0.0.0.0' }, () => {
  console.log(JSON.stringify({ service: 'site', message: 'service listening', port }));
});
