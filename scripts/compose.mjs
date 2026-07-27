#!/usr/bin/env node
/**
 * Thin wrapper around `docker compose` that always passes the project's two Compose files and the
 * git-ignored `.env`, so the Compose project name and the ports are the ones this copy was given.
 *
 * `docker/compose.yaml` describes the system; `docker/compose.local.yaml` adds what only local
 * development has — the PostgreSQL container and the published ports.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(repoRoot, '.env');

if (!existsSync(envPath)) {
  console.error('No .env found. Copy .env.example to .env first: cp .env.example .env');
  process.exit(1);
}

// Present only on machines where Docker's default address pools were exhausted; see
// scripts/allocate-network.mjs.
const networkOverride = join(repoRoot, 'docker/compose.network.local.yaml');

const files = [
  '-f',
  join(repoRoot, 'docker/compose.yaml'),
  '-f',
  join(repoRoot, 'docker/compose.local.yaml'),
];
if (existsSync(networkOverride)) files.push('-f', networkOverride);

const result = spawnSync(
  'docker',
  ['compose', '--env-file', envPath, ...files, ...process.argv.slice(2)],
  { cwd: repoRoot, stdio: 'inherit' },
);

process.exit(result.status ?? 1);
