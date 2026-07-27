#!/usr/bin/env node
/**
 * Compose configuration check.
 *
 * Verifies that the topology really matches the trust boundary: only Gateway is published to the
 * outside, the database never leaves loopback, and Adminer never gets a host port at all.
 *
 * Gateway may be opened to the local network — reaching the application from a virtual machine's
 * port forwarding or from a phone needs it — and that is reported rather than refused. The
 * database has no such exception: a wider bind there is always a mistake.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const composeFiles = ['docker/compose.yaml', 'docker/compose.local.yaml'].map((file) =>
  join(repoRoot, file),
);
const envPath = join(repoRoot, '.env');

/** Services allowed to publish a host port locally. Nothing else may. */
const PUBLISHABLE = new Set(['gateway', 'postgres']);
/** The database must never leave the loopback interface. */
const LOOPBACK = new Set(['127.0.0.1', '::1']);

let raw;
try {
  raw = execFileSync(
    'docker',
    [
      'compose',
      ...(existsSync(envPath) ? ['--env-file', envPath] : []),
      ...composeFiles.flatMap((file) => ['-f', file]),
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
const notes = [];

/**
 * The production topology, checked with values that only exist for the check.
 *
 * What matters there is stricter than locally: nothing is published at all, because the platform
 * routes a domain to Gateway's fixed internal port, and PostgreSQL is a managed resource rather
 * than a container of this application.
 */
function checkProduction() {
  const productionFile = join(repoRoot, 'docker/compose.yaml');
  if (!existsSync(productionFile)) {
    problems.push('docker/compose.yaml is missing');
    return;
  }

  let productionRaw;
  try {
    productionRaw = execFileSync(
      'docker',
      ['compose', '-f', productionFile, 'config', '--format', 'json'],
      {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PROJECT_SLUG: 'check',
          PUBLIC_SITE_URL: 'https://check.invalid',
          DATABASE_URL: 'postgres://check:check@db.invalid:5432/postgres',
          EMAIL_FROM_ADDRESS: 'no-reply@check.invalid',
        },
      },
    ).toString();
  } catch (error) {
    problems.push(
      `docker/compose.yaml did not parse: ${error.stderr?.toString().trim() ?? error.message}`,
    );
    return;
  }

  const production = JSON.parse(productionRaw);

  for (const [name, service] of Object.entries(production.services ?? {})) {
    if ((service.ports ?? []).length > 0) {
      problems.push(`"${name}" publishes a host port in production; nothing may`);
    }
  }

  if (production.services?.postgres) {
    problems.push('Production Compose contains a PostgreSQL container; the database is managed');
  }

  /*
   * The two topologies are written out in full, each readable on its own, and that is the one
   * hazard of it: a service added to one file and forgotten in the other. Compared here rather
   * than against a list kept by hand, which would be a third place to forget.
   *
   * PostgreSQL is the single deliberate difference: a container locally, a managed database in
   * production.
   */
  const local = new Set(Object.keys(config.services ?? {}));
  local.delete('postgres');
  const deployed = new Set(Object.keys(production.services ?? {}));

  for (const name of local) {
    if (!deployed.has(name)) problems.push(`"${name}" runs locally but is missing from production`);
  }
  for (const name of deployed) {
    if (!local.has(name)) problems.push(`"${name}" is deployed but missing from local development`);
  }
}

checkProduction();

for (const [name, service] of Object.entries(config.services ?? {})) {
  const ports = service.ports ?? [];

  if (ports.length > 0 && !PUBLISHABLE.has(name)) {
    problems.push(`"${name}" publishes a host port; only ${[...PUBLISHABLE].join(' and ')} may`);
  }

  for (const port of ports) {
    const host = typeof port === 'string' ? port.split(':')[0] : port.host_ip;
    if (host && LOOPBACK.has(host)) continue;

    const where = host || 'all interfaces';
    if (name === 'gateway') {
      notes.push(`Gateway is published on "${where}", not only on loopback`);
    } else {
      problems.push(
        `"${name}" publishes ${port.published ?? port} on "${where}"; ` +
          'only Gateway may be opened beyond loopback',
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

for (const note of notes) console.log(`Note: ${note}.`);
console.log(
  `Compose check passed (local publishes ${published.join(', ') || 'nothing'}; production nothing).`,
);
