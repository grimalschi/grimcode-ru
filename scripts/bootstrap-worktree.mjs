#!/usr/bin/env node
/** Creates a worktree's configuration and copies its database; reruns keep existing data. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const refreshDatabase = process.argv.includes('--refresh-database');

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function readEnv(file) {
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
}

/** Preserve quoted values, comments inside values and multiline strings under Node's .env syntax. */
function envLine(key, value) {
  for (const encoded of [value, `'${value}'`, `"${value}"`, `\`${value}\``]) {
    const line = `${key}=${encoded}`;
    const parsed = parseEnv(line);
    if (parsed[key] === value && Object.keys(parsed).length === 1) return line;
  }
  throw new Error(`Cannot serialize ${key} as a Node .env value.`);
}

function writeEnv(file, values) {
  const written = new Set();
  const lines = readFileSync(join(repoRoot, '.env.example'), 'utf8').split('\n').map((line) => {
    const key = /^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1];
    if (!key || !Object.hasOwn(values, key)) return line;
    written.add(key);
    return envLine(key, values[key]);
  });
  const extras = Object.entries(values).filter(([key]) => !written.has(key));
  if (extras.length) lines.push('', ...extras.map(([key, value]) => envLine(key, value)));
  writeFileSync(file, lines.join('\n'), { mode: 0o600 });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort(start, end, reserved) {
  for (let port = start; port <= end; port += 1) {
    if (!reserved.has(port) && await isPortFree(port)) return String(port);
  }
  throw new Error(`No free port left in ${start}..${end}. Widen the port range or remove a worktree.`);
}

function addressOnPort(address, port) {
  try {
    const url = new URL(address);
    url.port = String(port);
    return url.origin;
  } catch { return `http://127.0.0.1:${port}`; }
}

function normalizeSlug(value) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(slug) ? slug : `p_${slug}`;
}

/** A URI remains intact for libpq, including SSL options; errors never include the URI. */
function databaseUrl(value, label, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid PostgreSQL URL in ${label}.`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(`Invalid PostgreSQL URL in ${label}.`);
  if (name !== undefined) {
    url.pathname = `/${encodeURIComponent(name)}`;
    if (url.searchParams.has('dbname')) url.searchParams.set('dbname', name);
  }
  if (!databaseName(url) || Buffer.byteLength(databaseName(url), 'utf8') > 63) {
    throw new Error(`The database name in ${label} must contain 1..63 UTF-8 bytes.`);
  }
  return url;
}

function databaseName(url) {
  try { return url.searchParams.get('dbname') ?? decodeURIComponent(url.pathname.slice(1)); }
  catch { throw new Error('A PostgreSQL database name has invalid URL encoding.'); }
}

/** PostgreSQL commands receive no password on their command line. */
function run(command, url, args, { maintenance = false, input } = {}) {
  const address = new URL(url);
  const password = address.searchParams.get('password') ?? decodeURIComponent(address.password);
  address.password = '';
  address.searchParams.delete('password');
  if (maintenance) {
    address.pathname = '/postgres';
    if (address.searchParams.has('dbname')) address.searchParams.set('dbname', 'postgres');
  }
  const result = spawnSync(command, ['--dbname', address.toString(), ...args], {
    env: { ...process.env, PGPASSWORD: password }, input, maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = result.stderr?.toString().trim().slice(0, 500) || result.error?.code || 'no error details';
    // Native clients normally omit passwords; still redact one if a diagnostic includes it.
    throw new Error(`${command} failed: ${password ? detail.split(password).join('[redacted]') : detail}`);
  }
  return result.stdout;
}

function databaseExists(url) {
  const name = databaseName(url).replaceAll("'", "''");
  return run('psql', url, ['-tAc', `SELECT 1 FROM pg_database WHERE datname='${name}'`], { maintenance: true })
    .toString().trim() === '1';
}

async function bootstrap() {
  if (process.argv.slice(2).some((arg) => arg !== '--refresh-database')) {
    throw new Error('Usage: pnpm bootstrap:worktree [--refresh-database]');
  }
  const checkouts = git(['worktree', 'list', '--porcelain']).split('\n')
    .filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
  const mainCheckout = checkouts[0];
  if (!mainCheckout) throw new Error('git reported no main checkout.');
  if (resolve(mainCheckout) === resolve(repoRoot)) {
    throw new Error('This is the main checkout, not a worktree. Copy .env.example to .env here instead.');
  }
  const mainEnvPath = join(mainCheckout, '.env');
  if (!existsSync(mainEnvPath)) throw new Error(`The main checkout at ${mainCheckout} has no .env.`);
  const main = readEnv(mainEnvPath);
  const envPath = join(repoRoot, '.env');
  const existing = readEnv(envPath);
  const values = { ...main, ...existing };
  const slug = existing.PROJECT_SLUG || normalizeSlug(`${basename(repoRoot)}_${git(['rev-parse', '--abbrev-ref', 'HEAD'])}`);
  if (!main.PROJECT_SLUG || !/^[a-z][a-z0-9_]{0,62}$/.test(slug)) throw new Error('Both checkouts need a valid PROJECT_SLUG.');
  if (slug === main.PROJECT_SLUG) throw new Error('The worktree PROJECT_SLUG must differ from the main checkout.');

  const source = databaseUrl(main.DATABASE_URL, 'DATABASE_URL in the main checkout');
  const target = databaseUrl(existing.DATABASE_URL || main.DATABASE_URL, 'DATABASE_URL in this worktree',
    existing.DATABASE_URL ? undefined : slug);
  // Different hostnames and libpq options can still address the same server.
  if (databaseName(target) === databaseName(source)) {
    throw new Error('The worktree database name must differ from the main checkout database name.');
  }
  values.DATABASE_URL = existing.DATABASE_URL || target.toString();
  for (const key of Object.keys(values)) if (key.startsWith('DATABASE_URL_')) delete values[key];

  const start = Number(values.PORT_RANGE_START || 63000);
  const end = Number(values.PORT_RANGE_END || 63099);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) {
    throw new Error('PORT_RANGE_START..PORT_RANGE_END must be within 1..65535.');
  }
  const reserved = new Set([start, ...checkouts
    .filter((checkout) => resolve(checkout) !== resolve(repoRoot))
    .map((checkout) => Number(readEnv(join(checkout, '.env')).PORT))]);
  if (existing.PORT && (!Number.isInteger(Number(existing.PORT)) || Number(existing.PORT) < start ||
    Number(existing.PORT) > end || reserved.has(Number(existing.PORT)))) {
    throw new Error('The saved PORT is outside the range or assigned to another worktree; remove PORT and retry.');
  }
  const port = existing.PORT || await findFreePort(start, end, reserved);
  values.PROJECT_SLUG = slug;
  values.PORT = port;
  values.PUBLIC_SITE_URL = existing.PUBLIC_SITE_URL || addressOnPort(main.PUBLIC_SITE_URL, port);
  delete values.ACCEPTANCE_BASE_URL;
  writeEnv(envPath, values);
  console.log(`Main checkout: ${mainCheckout}\nWrote ${envPath}\n  PROJECT_SLUG ${slug}\n  PORT ${port}`);

  const present = databaseExists(target);
  if (present && !refreshDatabase) {
    console.log('Database kept (use --refresh-database to replace it).');
  } else {
    if (!databaseExists(source)) throw new Error('The main checkout database does not exist. Create it before bootstrapping a worktree.');
    // Obtain the source first: a dump failure must leave an existing worktree database intact.
    const dump = run('pg_dump', source, ['--no-owner', '--no-acl']);
    const name = databaseName(target).replaceAll('"', '""');
    if (present) run('psql', target, ['-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE "${name}" WITH (FORCE)`], { maintenance: true });
    run('psql', target, ['-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE "${name}"`], { maintenance: true });
    run('psql', target, ['-v', 'ON_ERROR_STOP=1', '--single-transaction', '-q'], { input: dump });
    console.log('Database copied with all module schemas.');
  }
  console.log('\nStart this worktree with: pnpm dev');
}

await bootstrap().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
