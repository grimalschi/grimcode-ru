import { pathToFileURL } from 'node:url';

import { createDatabaseInterface } from '@grimcode/pg-interface';
import { serve } from '@hono/node-server';
import { createModule as createAdminModule, type AdminEnv } from '@template/admin';
import { createApp as createAppApp } from '@template/app';
import { createModule as createAuthModule, type AuthEnv } from '@template/auth';
import {
  createModule as createEmailModule,
  type EmailEnv,
  type MailSettings,
} from '@template/email';
import { createApp as createGatewayApp, type GatewayTargets } from '@template/gateway';
import {
  createModule as createNotificationsModule,
  type NotificationsEnv,
} from '@template/notifications';
import {
  createMigrationWriter,
  findProjectRoot,
  intEnv,
  optionalEnv,
  projectSlug,
  publicSiteUrl,
  requireEnv,
  type FetchLike,
  type ServiceApp,
} from '@template/shared';
import { createApp as createSiteApp } from '@template/site/server';
import { createApp as createUsersApp, type UsersEnv } from '@template/users';

/**
 * Modules with a database of their own: each creates and migrates it, so this list only decides who
 * is told a connection string.
 */
export const DATABASE_MODULES = ['admin', 'auth', 'email', 'notifications', 'users'] as const;

export type DatabaseModule = (typeof DATABASE_MODULES)[number];

/** Every module that answers requests, by the name Gateway routes under. */
export type ModuleName = DatabaseModule | 'app' | 'gateway';

/** Each module declares its own `Bindings`, so a uniform map can promise only `fetch`. */
export type MountedApp = Pick<ServiceApp, 'fetch'>;

export interface Composition {
  apps: Record<ModuleName, MountedApp>;
}

/** The only place allowed to know every module, and all it knows is the order of calls. */
export async function compose(): Promise<Composition> {
  const mail = mailSettings();
  const auth = authSettings();

  assertDistinctDatabases();

  /*
   * Named one by one rather than only as a map: a caller into a neighbour is handed the same
   * environment a request would carry, and `Record<ModuleName, object>` would hand it `object`.
   */
  const adminEnv: AdminEnv = databaseEnv('admin');
  const authEnv: AuthEnv = { ...auth, ...databaseEnv('auth') };
  const emailEnv: EmailEnv = { ...databaseEnv('email'), mail };
  const notificationsEnv: NotificationsEnv = databaseEnv('notifications');
  const usersEnv: UsersEnv = databaseEnv('users');

  // `{}` means the module needs nothing per request — not that it reads the process itself.
  const envByModule: Record<ModuleName, object> = {
    admin: adminEnv,
    app: {},
    auth: authEnv,
    email: emailEnv,
    gateway: {},
    notifications: notificationsEnv,
    users: usersEnv,
  };

  /*
   * A call to a neighbour, and the one place a module's environment is supplied. The application is
   * looked up when the request arrives, not when this closure is made, so a module can be handed a
   * way to reach one that does not exist yet.
   */
  const call =
    (name: ModuleName): FetchLike =>
    (request) =>
      apps[name].fetch(request, envByModule[name]);

  const site = createSiteApp({ origin: publicSiteUrl() });

  /*
   * The panel's database section. Not a module: it looks at every module's database at once, which is
   * why only the owner reaches it and why no grant can name it. It opens its own small pools rather
   * than borrowing the modules' — a heavy query typed into the console would otherwise hold
   * connections the site needs.
   *
   * The path is Gateway's to route; it is repeated here because the interface has to know where it is
   * mounted to tell its own paths from the rest of the URL.
   */
  /*
   * Where a change of shape made in the database section is written: the migrations of the module whose
   * database it is. `SCHEMA_SOURCE_ROOT` names another project — a copy started for the browser checks,
   * which really do add and drop columns. Whether writing is possible at all is decided in `shared`,
   * beside the code that writes; nothing here chooses anything.
   */
  const writer = createMigrationWriter(
    optionalEnv('SCHEMA_SOURCE_ROOT', '') || findProjectRoot(),
    new Map(DATABASE_MODULES.map((module) => [serviceDatabaseName(module), module])),
  );

  const databaseInterface = createDatabaseInterface({
    basePath: '/admin/embed/database',
    databases: DATABASE_MODULES.map((module) => ({
      name: serviceDatabaseName(module),
      connectionString: serviceDatabaseUrl(module),
    })),
    ...(writer ? { writer } : {}),
  });

  const targets: GatewayTargets = {
    site: (request) => site.fetch(request),
    database: (request) => databaseInterface.fetch(request),
    app: call('app'),
    admin: call('admin'),
    auth: call('auth'),
    users: call('users'),
    notifications: call('notifications'),
    email: call('email'),
  };

  /*
   * A module with an internal surface is built once and reached two ways: by request, for what
   * Gateway routes to it, and by a caller, which is how a neighbour invokes its procedures. The
   * environment is supplied here in both cases — a direct call has no request to carry it.
   */
  const email = createEmailModule();
  const notifications = createNotificationsModule({
    callEmail: (called) => email.internalCaller(emailEnv, called),
  });
  const authModule = createAuthModule({
    callNotifications: (called) => notifications.internalCaller(notificationsEnv, called),
  });
  const admin = createAdminModule({
    callAuth: (called) => authModule.internalCaller(authEnv, called),
  });

  const apps: Record<ModuleName, MountedApp> = {
    email: email.app,
    notifications: notifications.app,
    auth: authModule.app,
    admin: admin.app,
    users: createUsersApp({ callAuth: (called) => authModule.internalCaller(authEnv, called) }),
    app: createAppApp(),
    gateway: createGatewayApp({
      targets,
      callAdmin: (called) => admin.internalCaller(adminEnv, called),
    }),
  };

  return { apps };
}

/**
 * Refuses a `PROJECT_SLUG` under which two modules would share one database — PostgreSQL truncates
 * identifiers silently. Before the modules are built, so it stops the program instead of surfacing
 * later as shared tables.
 */
function assertDistinctDatabases(): void {
  const seen = new Map<string, DatabaseModule>();

  for (const module of DATABASE_MODULES) {
    const database = serviceDatabaseName(module);
    const clash = seen.get(database);
    if (clash !== undefined) {
      throw new Error(
        `PROJECT_SLUG is too long: the databases of "${clash}" and "${module}" are both ` +
          `"${database}" once PostgreSQL cuts them to ${IDENTIFIER_LIMIT} bytes; shorten it, or ` +
          'two modules sharing one database would share their data.',
      );
    }
    seen.set(database, module);
  }
}

/**
 * The composer's side of what each module declares in its own `env.ts`. No shared type on purpose:
 * one in `shared` would make five modules agree with each other.
 */
export interface ModuleDatabase {
  databaseUrl: string;
  databaseName: string;
  maintenanceUrl: string;
}

/** A module gets strings, never variable names. */
export function databaseEnv(module: DatabaseModule): ModuleDatabase {
  return {
    databaseUrl: serviceDatabaseUrl(module),
    databaseName: serviceDatabaseName(module),
    maintenanceUrl: maintenanceDatabaseUrl(module),
  };
}

/**
 * Auth's settings; the default is a decision about this installation. Kept apart from `databaseEnv`
 * so it stays callable without a database, which is what lets `index.test.ts` pin that default.
 */
export function authSettings(): Omit<AuthEnv, keyof ModuleDatabase> {
  return {
    sessionTtlSeconds: intEnv('AUTH_SESSION_TTL_SECONDS', 60 * 60 * 24 * 30),
  };
}

/**
 * Forwarded as written: what empty means belongs to the module. Decided here, `EMAIL_PROVIDER`
 * misspelt would be this file choosing not to mail people.
 */
export function mailSettings(): MailSettings {
  return {
    provider: optionalEnv('EMAIL_PROVIDER', ''),
    apiKey: optionalEnv('UNISENDER_GO_API_KEY', ''),
    apiUrl: optionalEnv('UNISENDER_GO_API_URL', ''),
    fromAddress: optionalEnv('EMAIL_FROM_ADDRESS', ''),
    fromName: optionalEnv('EMAIL_FROM_NAME', ''),
  };
}

/**
 * One module's database: `DATABASE_URL` with the name swapped for `<PROJECT_SLUG>_<module>`. One
 * credential, not five — creating a database needs an account allowed to, and such an account opens
 * all of them.
 */
export function serviceDatabaseUrl(module: string): string {
  const override = optionalEnv(`DATABASE_URL_${module.toUpperCase()}`, '');
  if (override !== '') return override;

  const url = new URL(requireEnv('DATABASE_URL'));
  url.pathname = `/${serviceDatabaseName(module)}`;
  return url.toString();
}

/**
 * The server itself, for the one `CREATE DATABASE` a module runs: a database cannot be created from
 * inside itself. Derived from the module's own string, so a module handed `DATABASE_URL_<MODULE>` on
 * another server creates its database **there** — taken from `DATABASE_URL` it created the database on
 * the default server and then failed to connect to the one it was given, measured on two live servers.
 * The maintenance database to connect to meanwhile comes from `DATABASE_URL`: that is where the person
 * deploying wrote it.
 */
export function maintenanceDatabaseUrl(module: string): string {
  const url = new URL(serviceDatabaseUrl(module));
  url.pathname = new URL(requireEnv('DATABASE_URL')).pathname;
  return url.toString();
}

/** PostgreSQL cuts every identifier to this many bytes, silently. */
export const IDENTIFIER_LIMIT = 63;

export function serviceDatabaseName(module: string): string {
  return Buffer.from(`${projectSlug()}_${module}`, 'utf8')
    .subarray(0, IDENTIFIER_LIMIT)
    .toString();
}

/**
 * Port to listen on. `PORT` first, because that is what a hosting platform sets; then
 * `GATEWAY_PORT` from `.env`, which is what lets two worktrees run at once on one machine.
 *
 * No default on purpose. There used to be one, 8080, and it only ever applied when `.env` was
 * missing or empty — the case where the process would come up on a port nobody is routing to, look
 * healthy, and answer nothing anyone asked. A refusal names the problem instead.
 */
function ownPort(): number {
  for (const name of ['PORT', 'GATEWAY_PORT']) {
    const port = intEnv(name, 0);
    if (port !== 0) return port;
  }

  throw new Error(
    'Neither PORT nor GATEWAY_PORT is set, so there is no port to listen on. Locally that means ' +
      '.env is missing or has no GATEWAY_PORT; on a platform it means PORT was not supplied.',
  );
}

/**
 * The program, when this file is the program. Guarded because the same file is imported — by its
 * own tests and by the acceptance suite, which needs the database names — and an entry that opened
 * a port on import would open one there too.
 *
 * Opening the port lives here rather than in `shared` because there is one listener: the door out of
 * the process belongs to the program, and a module that could import it could open one of its own.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { apps } = await compose();

  serve({ fetch: apps.gateway.fetch, port: ownPort(), hostname: '0.0.0.0' });
}
