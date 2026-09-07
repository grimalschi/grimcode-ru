#!/usr/bin/env node
/**
 * Bootstrap for a git worktree.
 *
 * A worktree is a separate copy of the project working on a different branch. It gets its own `.env`,
 * its own port and its own databases; PostgreSQL itself is one server on this machine, shared by
 * every copy, and what keeps two branches apart is the slug the database names are built from.
 * Worktrees never share a database — one branch changing a schema would otherwise break the other.
 *
 * What it does:
 *
 *   1. finds the main checkout through git, never through a path written down somewhere;
 *   2. takes the main checkout's `.env` as the starting point and replaces what must differ;
 *   3. picks a free port inside PORT_RANGE_START..PORT_RANGE_END — never the first one, which
 *      belongs to the main checkout;
 *   4. copies the main checkout's local databases across with a logical dump and restore.
 *
 * The copy is of local development state, not of production data. A second run does **not** touch
 * a database this worktree already has: `--refresh-databases` is how that is asked for, so a day's
 * work here cannot be wiped by re-running bootstrap out of habit.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const refreshDatabases = process.argv.includes('--refresh-databases');

const STATEFUL_SERVICES = ['admin', 'auth', 'users', 'notifications', 'email'];

function git(args, cwd = repoRoot) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

/**
 * The checkout this worktree was created from.
 *
 * `git worktree list` names every checkout of the repository; the first is the main one. Asking git
 * means a worktree can be created anywhere without a path being configured.
 */
function findMainCheckout() {
  const lines = git(['worktree', 'list', '--porcelain']).split('\n');
  const paths = lines
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length)));

  const main = paths[0];
  if (!main) throw new Error('git reported no worktrees, which should be impossible');
  return main;
}

function parseEnv(text) {
  const values = new Map();
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * A free port inside the range the project reserved for worktrees.
 *
 * Worktrees come and go, so their ports are picked rather than chosen — and only from the range
 * `.env` declares, where nothing else on the machine is expected to listen.
 */
async function findFreePortInRange(start, end, taken) {
  for (let port = start; port <= end; port += 1) {
    if (taken.has(port)) continue;
    if (await isPortFree(port)) {
      taken.add(port);
      return port;
    }
  }
  throw new Error(
    `No free port left in ${start}..${end}. Widen PORT_RANGE_START/PORT_RANGE_END or remove a worktree.`,
  );
}

/**
 * The same address on another port.
 *
 * A checkout reachable from another machine has a real host in `PUBLIC_SITE_URL` —
 * `http://192.168.1.5:63006` for a phone on the same network — and a worktree of it needs that host
 * too. Only the port is this worktree's own; replacing the whole address would quietly send it back
 * to loopback and break what was set up deliberately.
 */
function sameAddressOnPort(address, port) {
  try {
    const url = new URL(address);
    url.port = String(port);
    return url.origin;
  } catch {
    return `http://127.0.0.1:${port}`;
  }
}

function normalizeSlug(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(slug) ? slug : `p_${slug}`;
}

/**
 * How to reach the local PostgreSQL, from `DATABASE_URL`.
 *
 * The password goes into the child's environment rather than onto its command line, where `ps` would
 * show it to everyone on the machine.
 */
function connection(env) {
  const url = new URL(env.get('DATABASE_URL') ?? '');
  return {
    args: ['-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username)],
    env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
  };
}

function psql(target, args, options = {}) {
  return spawnSync('psql', [...target.args, ...args], {
    env: target.env,
    stdio: options.capture || options.input ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    input: options.input,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
}

/**
 * Whether a database exists on the local server.
 *
 * A failed query is not the same as a missing database, and treating it as one would hand someone
 * an empty worktree while telling them there was nothing to copy. So a failure stops the run.
 */
function databaseExists(target, name) {
  const result = psql(
    target,
    // Without `-d postgres` psql connects to a database named after the user, which does not exist.
    ['-d', 'postgres', '-tAc', `SELECT 1 FROM pg_database WHERE datname='${name}'`],
    { capture: true },
  );

  if (result.status !== 0) {
    console.error(`Could not ask PostgreSQL whether ${name} exists:`);
    console.error(result.stderr?.toString().trim() || 'psql failed without a message');
    process.exit(1);
  }

  return result.stdout?.trim() === '1';
}

// --- Find where we are --------------------------------------------------------

const mainCheckout = findMainCheckout();

if (resolve(mainCheckout) === resolve(repoRoot)) {
  console.error('This is the main checkout, not a worktree. Copy .env.example to .env here instead.');
  process.exit(1);
}

const mainEnvPath = join(mainCheckout, '.env');
if (!existsSync(mainEnvPath)) {
  console.error(
    `The main checkout at ${mainCheckout} has no .env yet. Copy .env.example to .env there first.`,
  );
  process.exit(1);
}

console.log(`Main checkout: ${mainCheckout}`);

// --- Build this worktree's own configuration ----------------------------------

const envPath = join(repoRoot, '.env');
const mainEnv = parseEnv(readFileSync(mainEnvPath, 'utf8'));
const existing = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : new Map();

// The main checkout's file is the starting point: everything a human tuned there — the email
// transport, session lifetime, credentials — carries over, and only what must differ is replaced.
const resolved = new Map(mainEnv);
for (const [key, value] of existing) resolved.set(key, value);

const taken = new Set();
const slug = existing.get('PROJECT_SLUG') || normalizeSlug(`${basename(repoRoot)}_${git(['rev-parse', '--abbrev-ref', 'HEAD'])}`);

// --- The port -----------------------------------------------------------------

const rangeStart = Number(resolved.get('PORT_RANGE_START') || 63000);
const rangeEnd = Number(resolved.get('PORT_RANGE_END') || 63099);

/*
 * The first port of the range is the main checkout's, and so is whatever port its `.env` names.
 * Held back rather than probed: the main copy is often stopped while a branch is being set up, and
 * a port that merely happens to be free right now is not a port that is free to take.
 */
for (const reserved of [rangeStart, Number(mainEnv.get('GATEWAY_PORT'))]) {
  if (Number.isFinite(reserved) && reserved > 0) taken.add(reserved);
}

const gatewayPort =
  existing.get('GATEWAY_PORT') || String(await findFreePortInRange(rangeStart, rangeEnd, taken));

resolved.set('PROJECT_SLUG', slug);
resolved.set('GATEWAY_PORT', gatewayPort);
resolved.set(
  'PUBLIC_SITE_URL',
  existing.get('PUBLIC_SITE_URL') ||
    sameAddressOnPort(mainEnv.get('PUBLIC_SITE_URL') ?? 'http://127.0.0.1', gatewayPort),
);
// Carried over from the main checkout, it would point the test suites at the main checkout's port.
resolved.delete('ACCEPTANCE_BASE_URL');

// Everything local lives in the ignored `.env` and nowhere else.
const template = readFileSync(join(repoRoot, '.env.example'), 'utf8');
const written = new Set();
const lines = template.split('\n').map((line) => {
  const match = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
  if (!match || !resolved.has(match[1])) return line;
  written.add(match[1]);
  return `${match[1]}=${resolved.get(match[1])}`;
});

const extras = [...resolved.entries()].filter(([key]) => !written.has(key));
if (extras.length > 0) {
  lines.push('', '# Carried over from the main checkout.', ...extras.map(([k, v]) => `${k}=${v}`));
}

writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });

console.log(`Wrote ${envPath}`);
console.log(`  PROJECT_SLUG    ${slug}`);
console.log(`  GATEWAY_PORT    ${gatewayPort}`);

// --- Copy the local databases across -------------------------------------------

const mainSlug = mainEnv.get('PROJECT_SLUG');

if (!mainSlug) {
  console.log('\nThe main checkout has no PROJECT_SLUG, so there is nothing to copy.');
  process.exit(0);
}

/*
 * One server, two sets of databases: the main checkout's and this worktree's. Both connections are
 * built from their own `.env`, because a worktree may have been given a different account or a
 * PostgreSQL on another port entirely.
 */
const source = connection(mainEnv);
const target = connection(resolved);

/*
 * Both sides are probed, and separately, because a failure on either one has a different fix and the
 * same symptom. The main checkout's file is the likelier of the two to be stale: it is edited by hand
 * and is not what a worktree is being set up from.
 */
for (const [name, where, hint] of [
  ['this worktree', target, `.env here (${resolved.get('DATABASE_URL')})`],
  ['the main checkout', source, `${mainEnvPath} (${mainEnv.get('DATABASE_URL')})`],
]) {
  if (psql(where, ['-d', 'postgres', '-tAc', 'SELECT 1'], { capture: true }).status === 0) continue;

  console.error(`\nPostgreSQL did not answer for ${name}. The address comes from ${hint}.`);
  console.error('Start the server, or fix the address, and run bootstrap again.');
  process.exit(1);
}

let copied = 0;
let skipped = 0;

for (const service of STATEFUL_SERVICES) {
  const from = `${mainSlug}_${service}`;
  const to = `${slug}_${service}`;

  if (!databaseExists(source, from)) {
    console.log(`  ${service}: nothing to copy from the main checkout`);
    continue;
  }

  const present = databaseExists(target, to);

  // The whole point of the flag: a database this worktree has already been working in is left
  // exactly as it is unless replacing it was asked for out loud.
  if (present && !refreshDatabases) {
    console.log(`  ${service}: kept (already here — use --refresh-databases to replace it)`);
    skipped += 1;
    continue;
  }

  if (present) {
    psql(target, ['-d', 'postgres', '-c', `DROP DATABASE "${to}" WITH (FORCE)`], { capture: true });
  }

  const created = psql(target, ['-d', 'postgres', '-c', `CREATE DATABASE "${to}"`], {
    capture: true,
  });
  if (created.status !== 0) {
    console.error(`  ${service}: could not create ${to}`);
    console.error(created.stderr?.toString().trim());
    process.exit(1);
  }

  /*
   * Logical dump and restore rather than `CREATE DATABASE ... TEMPLATE`: a template copy refuses
   * while anything is connected to the source, and the main copy is usually running.
   */
  const dump = spawnSync('pg_dump', [...source.args, '--no-owner', '--no-acl', from], {
    env: source.env,
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
  });

  if (dump.status !== 0) {
    console.error(`  ${service}: dump failed`);
    console.error(dump.stderr?.toString().slice(0, 500));
    process.exit(1);
  }

  const restore = psql(target, ['-v', 'ON_ERROR_STOP=1', '-q', '-d', to], {
    input: dump.stdout,
    encoding: 'buffer',
  });

  if (restore.status !== 0) {
    console.error(`  ${service}: restore failed`);
    console.error(restore.stderr?.toString().slice(0, 500));
    process.exit(1);
  }

  console.log(`  ${service}: copied`);
  copied += 1;
}

console.log(`\n${copied} database(s) copied, ${skipped} kept as they were.`);
console.log('Start this worktree with:  pnpm dev');
