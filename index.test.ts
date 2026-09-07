import { afterEach, describe, expect, it } from 'vitest';

import {
  authSettings,
  compose,
  databaseEnv,
  mailSettings,
  maintenanceDatabaseUrl,
  serviceDatabaseName,
  serviceDatabaseUrl,
} from './index.js';

/**
 * The settings the composer reads on behalf of a module. They used to be read inside the modules, where
 * the modules' own tests covered the defaults — moving them here would have dropped that coverage.
 */
const OWNED = [
  'AUTH_SESSION_TTL_SECONDS',
  'EMAIL_PROVIDER',
  'UNISENDER_GO_API_KEY',
  'UNISENDER_GO_API_URL',
  'EMAIL_FROM_ADDRESS',
  'EMAIL_FROM_NAME',
] as const;

afterEach(() => {
  for (const name of OWNED) delete process.env[name];
});

describe('Auth settings', () => {
  it('default to a 30 day session', () => {
    expect(authSettings().sessionTtlSeconds).toBe(60 * 60 * 24 * 30);
  });

  it('honour an override', () => {
    process.env.AUTH_SESSION_TTL_SECONDS = '3600';
    expect(authSettings().sessionTtlSeconds).toBe(3600);
  });

  /** A silent fallback would turn a typo into a one-second session, and nothing else would report it. */
  it('refuses a lifetime that is not a number rather than falling back to the default', () => {
    process.env.AUTH_SESSION_TTL_SECONDS = 'месяц';
    expect(() => authSettings()).toThrow();
  });
});

describe('the database handed to a module', () => {
  /**
   * A module creates and opens its own database now, so what it is given is the whole of what it can
   * reach. Three fields, each with a job: the string it works through, the name it refuses to have
   * landed on anything else, and the server connection it needs for one `CREATE DATABASE`.
   */
  it('is the module database, the name it must land on, and the server', () => {
    process.env.PROJECT_SLUG = 'demo';
    process.env.DATABASE_URL = 'postgres://owner:secret@postgres:5432/postgres';

    expect(databaseEnv('auth')).toEqual({
      databaseUrl: 'postgres://owner:secret@postgres:5432/demo_auth',
      databaseName: 'demo_auth',
      maintenanceUrl: 'postgres://owner:secret@postgres:5432/postgres',
    });

    delete process.env.PROJECT_SLUG;
    delete process.env.DATABASE_URL;
  });
});

describe('a slug too long for five databases', () => {
  /**
   * The check `db-init` used to make, in the one place that still derives all five names.
   *
   * Sixty-one bytes of slug leave room for `_a` and nothing more, so `admin` and `auth` arrive as the
   * same database name — which is the shortest way to reach the collision, `_admin` and `_auth` being
   * the two names that share a prefix.
   */
  it('refuses a slug under which two modules would share one database', async () => {
    process.env.PROJECT_SLUG = 'a'.repeat(61);
    process.env.DATABASE_URL = 'postgres://owner:secret@postgres:5432/postgres';

    await expect(compose()).rejects.toThrow(/PROJECT_SLUG is too long/);

    delete process.env.PROJECT_SLUG;
    delete process.env.DATABASE_URL;
  });
});

describe('the database of one module', () => {
  /**
   * One credential and five databases. The account comes from `DATABASE_URL` untouched — a module
   * creates its own database when it is missing, which needs an account allowed to create one, and
   * such an account can open every database on the server.
   */
  it('swaps the database name and leaves the account alone', () => {
    process.env.PROJECT_SLUG = 'demo';
    process.env.DATABASE_URL = 'postgres://owner:secret@postgres:5432/postgres';

    expect(serviceDatabaseName('auth')).toBe('demo_auth');
    expect(serviceDatabaseUrl('auth')).toBe('postgres://owner:secret@postgres:5432/demo_auth');
  });

  /** The connection a module opens for one `CREATE DATABASE`, at the database the string names. */
  it('keeps the server connection pointed where it was', () => {
    process.env.DATABASE_URL = 'postgres://owner:secret@postgres:5432/postgres';
    expect(maintenanceDatabaseUrl('auth')).toBe('postgres://owner:secret@postgres:5432/postgres');
  });

  /**
   * A module handed its own server creates its database **there**.
   *
   * Taken from `DATABASE_URL`, the creation went to the default server while the module connected to
   * the one it was given: measured on two live servers, the log said `module database created` and the
   * next line said `database "…_auth" does not exist`. The maintenance database keeps its name from
   * `DATABASE_URL`, because that is where the name of the server's own database is written — `postgres`
   * on a stock installation, something else on a managed one.
   */
  it('creates the database on the server the module was given, not the default one', () => {
    process.env.PROJECT_SLUG = 'demo';
    process.env.DATABASE_URL = 'postgres://owner:secret@main:5432/postgres';
    process.env.DATABASE_URL_AUTH = 'postgres://own:word@elsewhere:63004/demo_auth';

    expect(maintenanceDatabaseUrl('auth')).toBe('postgres://own:word@elsewhere:63004/postgres');
    // Every other module still goes to the default server.
    expect(maintenanceDatabaseUrl('users')).toBe('postgres://owner:secret@main:5432/postgres');

    delete process.env.DATABASE_URL_AUTH;
  });

  it('keeps the name of the maintenance database as it was written', () => {
    process.env.PROJECT_SLUG = 'demo';
    process.env.DATABASE_URL = 'postgres://owner:secret@managed:5432/defaultdb';
    process.env.DATABASE_URL_AUTH = 'postgres://own:word@elsewhere:63004/demo_auth';

    expect(maintenanceDatabaseUrl('auth')).toBe('postgres://own:word@elsewhere:63004/defaultdb');

    delete process.env.DATABASE_URL_AUTH;
  });

  /** Fail closed: nothing is guessed when the one connection string is missing. */
  it('refuses to derive anything without DATABASE_URL', () => {
    delete process.env.DATABASE_URL;
    expect(() => serviceDatabaseUrl('auth')).toThrow(/DATABASE_URL/);
    expect(() => maintenanceDatabaseUrl('auth')).toThrow(/DATABASE_URL/);
  });

  /** A password with `@` or `/` in it tears a concatenated string apart; `URL` carries it as written. */
  it('survives a password with characters that would tear a url apart', () => {
    process.env.PROJECT_SLUG = 'demo';
    process.env.DATABASE_URL = 'postgres://owner:p%40ss%2Fword@postgres:5432/postgres';

    const parsed = new URL(serviceDatabaseUrl('auth'));
    expect(parsed.hostname).toBe('postgres');
    expect(decodeURIComponent(parsed.password)).toBe('p@ss/word');
    expect(parsed.pathname).toBe('/demo_auth');
  });

  it('prefers an explicit per-service override', () => {
    process.env.DATABASE_URL_EMAIL = 'postgres://other@db:5432/custom';
    expect(serviceDatabaseUrl('email')).toBe('postgres://other@db:5432/custom');
    delete process.env.DATABASE_URL_EMAIL;
  });

  /**
   * The address is taken as written. It used to be rewritten when the application ran on the machine
   * instead of in a container — the host inside the network did not exist outside it — and with the
   * containers gone there is one address again, wherever the program runs.
   */
  it('keeps the host and port of DATABASE_URL exactly as given', () => {
    process.env.PROJECT_SLUG = 'demo';
    process.env.DATABASE_URL = 'postgres://owner:secret@127.0.0.1:63003/postgres';

    expect(serviceDatabaseUrl('auth')).toBe('postgres://owner:secret@127.0.0.1:63003/demo_auth');
    expect(maintenanceDatabaseUrl('auth')).toBe('postgres://owner:secret@127.0.0.1:63003/postgres');
  });
});

describe('mail settings', () => {
  it('are empty when unset, and say nothing about what empty means', () => {
    // Empty is the module's decision to interpret: no provider is the log transport, not a failure.
    expect(mailSettings()).toEqual({
      provider: '',
      apiKey: '',
      apiUrl: '',
      fromAddress: '',
      fromName: '',
    });
  });

  it('are forwarded as written', () => {
    process.env.EMAIL_PROVIDER = 'unisender-go';
    process.env.UNISENDER_GO_API_KEY = 'ключ';
    process.env.EMAIL_FROM_ADDRESS = 'no-reply@example.test';

    const mail = mailSettings();

    expect(mail.provider).toBe('unisender-go');
    expect(mail.apiKey).toBe('ключ');
    expect(mail.fromAddress).toBe('no-reply@example.test');
  });
});
