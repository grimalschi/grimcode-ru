#!/usr/bin/env node
/**
 * Local bootstrap.
 *
 * Chooses the project slug, free host ports and the local public URL, and writes them into the
 * git-ignored `.env`. Values a human already put there are never overwritten: only missing keys
 * are filled in, so running this again is safe.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  clearOverride,
  defaultPoolsAvailable,
  findFreeSubnet,
  writeOverride,
} from './allocate-network.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(repoRoot, '.env');
const examplePath = join(repoRoot, '.env.example');

/** Parses a dotenv file into an ordered map, keeping comments out of the way. */
function parseEnv(text) {
  const values = new Map();
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function slugFromRepository() {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    const name = remote.replace(/\.git$/, '').split(/[/:]/).pop();
    if (name) return normalizeSlug(name);
  } catch {
    // No remote yet — the directory name is a perfectly good default.
  }
  return normalizeSlug(basename(repoRoot));
}

function normalizeSlug(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  // PostgreSQL database names are built from this, so it must start with a letter.
  return /^[a-z]/.test(slug) ? slug : `p_${slug}`;
}

function isPortFree(port, host) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

async function findFreePort(preferred, host, taken) {
  for (let port = preferred; port < preferred + 200; port += 1) {
    if (taken.has(port)) continue;
    if (await isPortFree(port, host)) {
      taken.add(port);
      return port;
    }
  }
  throw new Error(`No free port found near ${preferred}`);
}

const existing = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : new Map();
const template = readFileSync(examplePath, 'utf8');

const bindHost = existing.get('LOCAL_BIND_HOST') ?? '127.0.0.1';
const taken = new Set();

const slug = existing.get('PROJECT_SLUG') || slugFromRepository();
const gatewayPort = existing.get('GATEWAY_PORT') || String(await findFreePort(8080, bindHost, taken));
const postgresPort =
  existing.get('POSTGRES_PORT') || String(await findFreePort(5432, bindHost, taken));

const resolved = new Map(existing);
resolved.set('PROJECT_SLUG', slug);
resolved.set('GATEWAY_PORT', gatewayPort);
resolved.set('POSTGRES_PORT', postgresPort);
resolved.set('LOCAL_BIND_HOST', bindHost);

if (!resolved.get('PUBLIC_SITE_URL')) {
  resolved.set('PUBLIC_SITE_URL', `http://${bindHost}:${gatewayPort}`);
}
if (!resolved.get('AUTH_SESSION_SECRET') || resolved.get('AUTH_SESSION_SECRET')?.includes('change-me')) {
  resolved.set('AUTH_SESSION_SECRET', randomBytes(32).toString('base64url'));
}

const user = resolved.get('POSTGRES_USER') || 'template';
const password = resolved.get('POSTGRES_PASSWORD') || randomBytes(12).toString('base64url');
resolved.set('POSTGRES_USER', user);
resolved.set('POSTGRES_PASSWORD', password);
if (!resolved.get('DATABASE_URL')) {
  resolved.set('DATABASE_URL', `postgres://${user}:${password}@postgres:5432/postgres`);
}

// Rewrite `.env.example` line by line so the file keeps its comments and its order, and any key a
// human added by hand is appended untouched.
const written = new Set();
const lines = template.split('\n').map((line) => {
  const match = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
  if (!match) return line;
  const key = match[1];
  if (!resolved.has(key)) return line;
  written.add(key);
  return `${key}=${resolved.get(key)}`;
});

const extras = [...resolved.entries()].filter(([key]) => !written.has(key));
if (extras.length > 0) {
  lines.push('', '# Added locally.', ...extras.map(([key, value]) => `${key}=${value}`));
}

writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });

console.log(`Wrote ${envPath}`);
console.log(`  PROJECT_SLUG    ${slug}`);
console.log(`  GATEWAY_PORT    ${gatewayPort} (bound to ${bindHost})`);
console.log(`  POSTGRES_PORT   ${postgresPort} (bound to ${bindHost})`);
console.log(`  PUBLIC_SITE_URL ${resolved.get('PUBLIC_SITE_URL')}`);

// Docker normally allocates the network itself. Only when its address pools are exhausted — which
// happens on a machine running many worktrees — does this copy get its own subnet.
const probe = `template-network-probe-${process.pid}`;
if (defaultPoolsAvailable(probe)) {
  clearOverride();
} else {
  const subnet = findFreeSubnet();
  writeOverride(subnet);
  console.log(`  network         ${subnet} (Docker's default pools are exhausted)`);
}

console.log('');
console.log('Start the project with:  pnpm up');
