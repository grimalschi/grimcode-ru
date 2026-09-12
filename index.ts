import { serve } from '@hono/node-server';
import type { ModuleInstance } from '@template/contracts/module-instance';
import { createModule as createAdmin } from '@template/admin';
import { createModule as createAuth } from '@template/auth';
import { createModule as createEmail } from '@template/email';
import { createModule as createNotifications } from '@template/notifications';
import { createModule as createRouter } from '@template/router';
import { createModule as createUsers } from '@template/users';
import { createModule as createWeb } from '@template/web/server';

const env = process.env;

function required(name: string) {
  const value = env[name];
  if (!value) throw new Error(`Required environment variable ${name} is not set`);
  return value;
}

const port = Number(env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
const slug = required('PROJECT_SLUG');
if (!/^[a-z][a-z0-9_]{0,62}$/.test(slug)) throw new Error('PROJECT_SLUG must be a lowercase identifier of 1..63 characters');
const databaseUrl = required('DATABASE_URL');
const origin = new URL(required('PUBLIC_SITE_URL'));
if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
  origin.pathname !== '/' || origin.search || origin.hash) throw new Error('PUBLIC_SITE_URL must be an HTTP(S) origin');
const session = {
  sessionCookieName: `${slug}_session`, publicOrigin: origin.origin,
};

const email = createEmail({
  env: {
    databaseUrl, csrfCookieName: `${slug}_csrf_email`,
    mail: {
      provider: env.EMAIL_PROVIDER, apiKey: env.UNISENDER_GO_API_KEY,
      apiUrl: env.UNISENDER_GO_API_URL, fromAddress: env.EMAIL_FROM_ADDRESS,
      fromName: env.EMAIL_FROM_NAME,
    },
  },
});
const notifications = createNotifications({
  env: { databaseUrl },
  modules: { email: email.internalCaller },
});
const auth = createAuth({
  env: {
    databaseUrl, ...session, csrfCookieName: `${slug}_csrf_auth`,
    sessionTtlSeconds: env.AUTH_SESSION_TTL_SECONDS ? Number(env.AUTH_SESSION_TTL_SECONDS) : undefined,
  },
  modules: { notifications: notifications.internalCaller },
});
const users = createUsers({
  env: {
    databaseUrl, sessionCookieName: session.sessionCookieName,
  },
  modules: { auth: auth.internalCaller },
});
const instances: ModuleInstance[] = [email, notifications, auth, users];
const admin = createAdmin({
  env: { databaseUrl, ...session, csrfCookieName: `${slug}_csrf_panel` },
  modules: { auth: auth.internalCaller },
  catalogue: instances.flatMap(({ id, admin }) => admin ? [{ id, admin }] : []),
});
const web = createWeb({ env: { origin: session.publicOrigin } });

const router = createRouter({
  env: session,
  modules: { admin: admin.internalCaller },
  publicFetches: {
    ...Object.fromEntries(instances.flatMap(({ id, publicFetch }) =>
      publicFetch ? [[id, publicFetch] as const] : [])),
    web: web.publicFetch,
  },
  adminFetches: {
    ...Object.fromEntries(instances.flatMap(({ id, adminFetch }) =>
      adminFetch ? [[id, adminFetch] as const] : [])),
    admin: admin.adminFetch,
  },
});

instances.push(admin, web, router);
for (const instance of instances) {
  await instance.migrate?.();
}

serve({ fetch: router.publicFetch, port, hostname: '0.0.0.0' });
