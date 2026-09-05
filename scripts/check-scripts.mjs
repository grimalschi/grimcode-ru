#!/usr/bin/env node
/**
 * Scripts must not be shadowed by pnpm's own commands.
 *
 * `pnpm up` looks like it runs the `up` script; it runs pnpm's dependency update instead, silently
 * rewriting the lockfile while the person waits for the project to start. Every name pnpm reserves
 * is refused here, so the trap cannot be set again.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// pnpm's own commands and their aliases, as of pnpm 9.
const RESERVED = new Set([
  'add', 'audit', 'bin', 'config', 'create', 'dedupe', 'deploy', 'dlx', 'doctor', 'env', 'exec',
  'fetch', 'import', 'init', 'install', 'i', 'install-test', 'it', 'licenses', 'link', 'ln',
  'list', 'ls', 'outdated', 'pack', 'patch', 'patch-commit', 'patch-remove', 'prune', 'publish',
  'rebuild', 'rb', 'remove', 'rm', 'root', 'run', 'server', 'setup', 'store', 'test', 't',
  'unlink', 'update', 'up', 'upgrade', 'why',
]);

// npm lifecycle names pnpm runs as scripts on purpose; they are not shadowed.
const ALLOWED = new Set(['test', 'start', 'stop', 'restart']);

const problems = [];
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

for (const name of Object.keys(manifest.scripts ?? {})) {
  if (RESERVED.has(name) && !ALLOWED.has(name)) {
    problems.push(`"${name}" is a pnpm command; \`pnpm ${name}\` would never run this script`);
  }
}

if (problems.length > 0) {
  console.error('Script names that pnpm would shadow:');
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}

console.log(`Script names checked (${Object.keys(manifest.scripts ?? {}).length}).`);
