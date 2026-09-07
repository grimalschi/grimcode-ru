import pg from 'pg';

import type { Queryable } from './catalog.js';

/** One database this interface may look at, as the program that builds it names them. */
export interface DatabaseSource {
  /** What a person sees and what the API addresses it by. */
  name: string;
  connectionString: string;
}

/**
 * Connections of this interface's own, never the application's — the decision the package rests on.
 * A borrowed pool would tie the console to the site: a heavy query typed here would hold connections
 * the site needs, an open transaction would hold a lock on a live table, and session state left
 * behind would reach the next request. So: separate pools, small, opened on first use.
 */
const MAX_CONNECTIONS = 2;

export interface Pools {
  /** The pool for one database, opened on the first request that needs it. */
  of(name: string): Promise<Queryable>;
  names(): string[];
  /** Closes what was opened. For a test, and for a program that wants to stop cleanly. */
  end(): Promise<void>;
}

/**
 * How a database is opened. The real one is below; a test hands in its own, which is the only reason
 * this is an argument — every other way of testing this package would need a live server.
 */
export type Connect = (source: DatabaseSource) => Promise<Queryable>;

export function createPools(databases: DatabaseSource[], connect: Connect = openPool): Pools {
  const sources = new Map(databases.map((database) => [database.name, database]));

  /*
   * The promise is remembered, not the pool: two requests arriving together would both find nothing
   * remembered and both open a pool, and the second one would never be closed. Storing the promise
   * makes the second request wait for the first one's pool.
   */
  const opened = new Map<string, Promise<Queryable>>();

  return {
    async of(name) {
      const source = sources.get(name);
      if (!source) throw new UnknownDatabase(name);

      const existing = opened.get(name);
      if (existing) return existing;

      const pool = connect(source);
      opened.set(name, pool);
      return pool;
    },

    names() {
      return [...sources.keys()];
    },

    async end() {
      const pools = [...opened.values()];
      opened.clear();

      await Promise.all(
        pools.map(async (pending) => {
          const pool = await pending;
          if (closeable(pool)) await pool.end().catch(() => undefined);
        }),
      );
    },
  };
}

function closeable(pool: Queryable): pool is Queryable & { end(): Promise<void> } {
  return typeof (pool as { end?: unknown }).end === 'function';
}

/**
 * Types read as written rather than as moments in time. The driver turns `date` and `timestamp` into a
 * `Date`, which is a point on the timeline, and neither of them is one: measured three hours east of
 * UTC, the stored date `2026-08-27` came back as `2026-08-26T21:00:00.000Z`, and 10:00 became 07:00Z.
 * Both are handed over as text. `timestamptz` is left alone — that one really is a moment.
 */
const READ_AS_WRITTEN = new Set([
  1082, // date
  1114, // timestamp without time zone
]);

export function typeParsers(): { getTypeParser: (oid: number, format?: unknown) => unknown } {
  return {
    getTypeParser(oid, format) {
      if (READ_AS_WRITTEN.has(oid)) return (value: string) => value;
      return pg.types.getTypeParser(oid, format as never);
    },
  };
}

async function openPool(source: DatabaseSource): Promise<Queryable> {
  const pool = new pg.Pool({
    connectionString: source.connectionString,
    types: typeParsers(),
    max: MAX_CONNECTIONS,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // What `pg_stat_activity` shows, and the reason a heavy query here can be told from the site's.
    application_name: 'pg-interface',
  });

  /*
   * Registered and empty: without a listener a connection that breaks while idle takes the whole
   * process down, and this package runs inside the application's. Nothing is reported — the request
   * that needed the connection fails on its own, and that is what a person sees.
   */
  pool.on('error', () => undefined);

  return pool;
}

export class UnknownDatabase extends Error {
  constructor(readonly database: string) {
    super(`No database named ${database} was given to this interface.`);
    this.name = 'UnknownDatabase';
  }
}
