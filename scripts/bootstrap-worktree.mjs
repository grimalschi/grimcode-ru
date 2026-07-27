#!/usr/bin/env node
/**
 * Bootstrap for a git worktree.
 *
 * A worktree is a separate copy of the project working on a different branch, and it gets its own
 * everything: its own Compose project, its own PostgreSQL container, its own volume and its own
 * free ports. Worktrees never share a database — one branch changing a schema would otherwise
 * break the other.
 *
 * What it does:
 *
 *   1. finds the main checkout through git, never through a path written down somewhere;
 *   2. takes the main checkout's `.env` as the starting point and replaces what must differ;
 *   3. clears away what deleted worktrees left on the machine — their networks hold address space
 *      nothing will use again, which is what exhausts Docker's pools;
 *   4. picks free ports inside PORT_RANGE_START..PORT_RANGE_END — never the first one, which
 *      belongs to the main checkout — and, if the pools are exhausted anyway, a free subnet;
 *   5. copies the main checkout's local databases across with a logical dump and restore.
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

import {
  defaultPoolsAvailable,
  findFreeSubnet,
  orphanedProjectVolumes,
  readOverride,
  removeStaleProjectNetworks,
  writeOverride,
} from './allocate-network.mjs';

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

/** Every project slug a checkout of this repository still claims. */
function liveProjectSlugs() {
  const slugs = new Set();
  for (const line of git(['worktree', 'list', '--porcelain']).split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const envFile = join(resolve(line.slice('worktree '.length)), '.env');
    if (!existsSync(envFile)) continue;
    const slug = parseEnv(readFileSync(envFile, 'utf8')).get('PROJECT_SLUG');
    if (slug) slugs.add(slug);
  }
  return slugs;
}

function normalizeSlug(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(slug) ? slug : `p_${slug}`;
}

/**
 * Whether a database exists on that checkout's PostgreSQL.
 *
 * A failed query is not the same as a missing database, and treating it as one would hand someone
 * an empty worktree while telling them there was nothing to copy. So a failure stops the run.
 */
function databaseExists(root, dbUser, name) {
  const result = compose(
    root,
    [
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      dbUser,
      // Without this psql connects to a database named after the user, which does not exist.
      '-d',
      'postgres',
      '-tAc',
      `SELECT 1 FROM pg_database WHERE datname='${name}'`,
    ],
    { capture: true },
  );

  if (result.status !== 0) {
    console.error(`Could not ask ${root} whether ${name} exists:`);
    console.error(result.stderr?.toString().trim() || 'psql failed without a message');
    process.exit(1);
  }

  return result.stdout?.trim() === '1';
}

function compose(root, args, options = {}) {
  return spawnSync('node', [join(root, 'scripts/compose.mjs'), ...args], {
    cwd: root,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
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

// --- Clear away what deleted worktrees left behind ----------------------------

const live = liveProjectSlugs();
live.add(slug);
live.add(mainEnv.get('PROJECT_SLUG') ?? '');

for (const network of removeStaleProjectNetworks(live)) {
  console.log(`Removed the network of a checkout that is gone: ${network.name} ${network.subnet}`);
}

const orphanedVolumes = orphanedProjectVolumes(live);

// --- Ports --------------------------------------------------------------------

const rangeStart = Number(resolved.get('PORT_RANGE_START') || 63000);
const rangeEnd = Number(resolved.get('PORT_RANGE_END') || 63099);

/*
 * The first port of the range is the main checkout's, and so are whatever ports its `.env` names.
 * Held back rather than probed: the main stack is often stopped while a branch is being set up, and
 * a port that merely happens to be free right now is not a port that is free to take.
 */
for (const reserved of [
  rangeStart,
  Number(mainEnv.get('GATEWAY_PORT')),
  Number(mainEnv.get('POSTGRES_PORT')),
]) {
  if (Number.isFinite(reserved) && reserved > 0) taken.add(reserved);
}

const gatewayPort =
  existing.get('GATEWAY_PORT') || String(await findFreePortInRange(rangeStart, rangeEnd, taken));
const postgresPort =
  existing.get('POSTGRES_PORT') || String(await findFreePortInRange(rangeStart, rangeEnd, taken));

resolved.set('PROJECT_SLUG', slug);
resolved.set('GATEWAY_PORT', gatewayPort);
resolved.set('POSTGRES_PORT', postgresPort);
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
console.log(`  POSTGRES_PORT   ${postgresPort}`);

// Docker usually allocates the network itself; a pinned subnet is kept as it is.
const pinned = readOverride();
if (pinned) {
  console.log(`  network         ${pinned} (already pinned for this worktree)`);
} else if (!defaultPoolsAvailable(`template-worktree-probe-${process.pid}`)) {
  const subnet = findFreeSubnet();
  writeOverride(subnet);
  console.log(`  network         ${subnet} (Docker's default pools are exhausted)`);
}

if (orphanedVolumes.length > 0) {
  // Not removed here: a volume is the database of a branch someone may still want back.
  console.log('');
  console.log('Volumes of checkouts that no longer exist are still on this machine:');
  for (const name of orphanedVolumes) console.log(`  ${name}`);
  console.log(`Remove them with:  docker volume rm ${orphanedVolumes.join(' ')}`);
}

// --- Copy the local databases across -------------------------------------------

const mainSlug = mainEnv.get('PROJECT_SLUG');
// Fixed for every local copy, main and worktree alike: this database never leaves the machine.
const user = 'template';
const mainUser = user;

if (!mainSlug) {
  console.log('\nThe main checkout has no PROJECT_SLUG, so there is nothing to copy.');
  process.exit(0);
}

console.log('\nStarting this worktree’s PostgreSQL…');
compose(repoRoot, ['up', '-d', 'postgres']);

// Wait for it to accept connections rather than guessing at a delay.
for (let attempt = 0; ; attempt += 1) {
  const ready = compose(repoRoot, ['exec', '-T', 'postgres', 'pg_isready', '-U', user, '-d', 'postgres'], {
    capture: true,
  });
  if (ready.status === 0) break;
  if (attempt > 30) {
    console.error('PostgreSQL did not become ready.');
    process.exit(1);
  }
  await new Promise((done) => setTimeout(done, 1000));
}

let copied = 0;
let skipped = 0;

for (const service of STATEFUL_SERVICES) {
  const source = `${mainSlug}_${service}`;
  const target = `${slug}_${service}`;

  const sourceExists = databaseExists(mainCheckout, mainUser, source);
  if (!sourceExists) {
    console.log(`  ${service}: nothing to copy from the main checkout`);
    continue;
  }

  const targetPresent = databaseExists(repoRoot, user, target);

  // The whole point of the flag: a database this worktree has already been working in is left
  // exactly as it is unless replacing it was asked for out loud.
  if (targetPresent && !refreshDatabases) {
    console.log(`  ${service}: kept (already here — use --refresh-databases to replace it)`);
    skipped += 1;
    continue;
  }

  if (targetPresent) {
    compose(repoRoot, ['exec', '-T', 'postgres', 'dropdb', '-U', user, '--force', target]);
  }
  compose(repoRoot, ['exec', '-T', 'postgres', 'createdb', '-U', user, '--maintenance-db', 'postgres', target]);

  // Logical dump and restore, not a copy of the Docker volume: the two servers are separate
  // containers with their own data directories, and a volume copy would carry the source's
  // credentials and cluster identity with it.
  const dump = spawnSync(
    'node',
    [join(mainCheckout, 'scripts/compose.mjs'), 'exec', '-T', 'postgres', 'pg_dump', '-U', mainUser, '--no-owner', '--no-acl', source],
    { cwd: mainCheckout, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
  );

  if (dump.status !== 0) {
    console.error(`  ${service}: dump failed`);
    console.error(dump.stderr?.toString().slice(0, 500));
    process.exit(1);
  }

  const restore = spawnSync(
    'node',
    [join(repoRoot, 'scripts/compose.mjs'), 'exec', '-T', 'postgres', 'psql', '-U', user, '-v', 'ON_ERROR_STOP=1', '-q', '-d', target],
    { cwd: repoRoot, input: dump.stdout, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
  );

  if (restore.status !== 0) {
    console.error(`  ${service}: restore failed`);
    console.error(restore.stderr?.toString().slice(0, 500));
    process.exit(1);
  }

  console.log(`  ${service}: copied`);
  copied += 1;
}

console.log(`\n${copied} database(s) copied, ${skipped} kept as they were.`);
console.log('Start this worktree with:  pnpm up');
