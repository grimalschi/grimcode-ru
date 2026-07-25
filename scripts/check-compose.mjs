#!/usr/bin/env node
/**
 * Compose configuration check.
 *
 * Verifies that the topology really matches the trust boundary: only Gateway is published to the
 * outside, local host ports listen on loopback, and Adminer never gets a host port at all.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const composeFile = join(repoRoot, 'docker/compose.yaml');
const envPath = join(repoRoot, '.env');

/** Services allowed to publish a host port locally. Nothing else may. */
const PUBLISHABLE = new Set(['gateway', 'postgres']);
/** Locally published ports must stay on the loopback interface unless overridden on purpose. */
const LOOPBACK = new Set(['127.0.0.1', '::1']);

let raw;
try {
  raw = execFileSync(
    'docker',
    [
      'compose',
      ...(existsSync(envPath) ? ['--env-file', envPath] : []),
      '-f',
      composeFile,
      'config',
      '--format',
      'json',
    ],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  ).toString();
} catch (error) {
  console.error('docker compose config failed:');
  console.error(error.stderr?.toString() ?? error.message);
  process.exit(1);
}

const config = JSON.parse(raw);
const problems = [];

for (const [name, service] of Object.entries(config.services ?? {})) {
  const ports = service.ports ?? [];

  if (ports.length > 0 && !PUBLISHABLE.has(name)) {
    problems.push(`"${name}" publishes a host port; only ${[...PUBLISHABLE].join(' and ')} may`);
  }

  for (const port of ports) {
    const host = typeof port === 'string' ? port.split(':')[0] : port.host_ip;
    if (!host || !LOOPBACK.has(host)) {
      problems.push(
        `"${name}" publishes ${port.published ?? port} on "${host || 'all interfaces'}"; ` +
          'local ports must bind to loopback',
      );
    }
  }
}

if (!config.services?.adminer) {
  problems.push('The adminer service is missing from the Compose topology');
} else if ((config.services.adminer.ports ?? []).length > 0) {
  problems.push('Adminer must never have a host port; it is reachable only through Gateway');
}

if (!config.services?.gateway) problems.push('The gateway service is missing');

if (problems.length > 0) {
  console.error('Compose configuration problems:');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

const published = Object.entries(config.services)
  .filter(([, service]) => (service.ports ?? []).length > 0)
  .map(([name]) => name);

console.log(`Compose check passed (published: ${published.join(', ') || 'nothing'}).`);
