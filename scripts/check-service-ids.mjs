#!/usr/bin/env node
/**
 * Reconciles the three explicit declarations of admin service ids:
 *
 * - `contracts/src/common.ts`         — the canonical lists
 * - `services/gateway/src/registry.ts` — what Gateway is willing to proxy
 * - `services/admin/web/src/services.ts` — what the central Admin shell shows
 *
 * None of them derives the ids at runtime, on purpose. This check is what keeps them in step, so a
 * service can never be reachable through Gateway while being invisible in the shell, or listed in
 * the shell without being routable.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function read(relative) {
  return readFileSync(join(repoRoot, relative), 'utf8');
}

/** Extracts the string literals of a named `as const` array declaration. */
function constArray(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`, 's').exec(source);
  if (!match) throw new Error(`Could not find the declaration of ${name}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

/** Extracts the keys of an object literal assigned to a named constant. */
function objectKeys(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*\\{(.*?)\\n\\}`, 's').exec(source);
  if (!match) throw new Error(`Could not find the declaration of ${name}`);
  return [...match[1].matchAll(/^\s{2}([a-z][a-zA-Z0-9]*):/gm)].map((entry) => entry[1]);
}

const contracts = read('contracts/src/common.ts');
const gateway = read('services/gateway/src/registry.ts');
const shell = read('services/admin/web/src/services.ts');

const canonicalAdmin = constArray(contracts, 'ADMIN_SERVICE_IDS');
const canonicalAssignable = constArray(contracts, 'ASSIGNABLE_SERVICE_IDS');
const gatewayAdmin = objectKeys(gateway, 'ADMIN_SERVICES');
const gatewayPublic = objectKeys(gateway, 'PUBLIC_SERVICES');
const shellServices = [...shell.matchAll(/\bid:\s*'([a-z]+)'/g)].map((entry) => entry[1]);

const problems = [];

const sorted = (values) => [...values].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

if (!same(canonicalAdmin, gatewayAdmin)) {
  problems.push(
    `Gateway admin allowlist [${sorted(gatewayAdmin)}] does not match ` +
      `ADMIN_SERVICE_IDS [${sorted(canonicalAdmin)}]`,
  );
}

if (!same(canonicalAdmin, shellServices)) {
  problems.push(
    `Admin shell sidebar [${sorted(shellServices)}] does not match ` +
      `ADMIN_SERVICE_IDS [${sorted(canonicalAdmin)}]`,
  );
}

// Adminer is owner-only and must never be reachable without an admin check.
if (canonicalAdmin.includes('adminer')) {
  problems.push(
    'Adminer is listed as an admin service. It is a section of the Admin panel, not a service: ' +
      'it reads every service’s data at once, which is why no grant can name it.',
  );
}

if (gatewayPublic.includes('adminer')) {
  problems.push('Adminer must never appear in Gateway\'s public allowlist');
}
if (canonicalAssignable.includes('adminer')) {
  problems.push('Adminer must never be an assignable service grant');
}

for (const service of canonicalAssignable) {
  if (!canonicalAdmin.includes(service)) {
    problems.push(`Assignable service "${service}" is not an admin service`);
  }
}

if (problems.length > 0) {
  console.error('Service id declarations disagree:');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log(
  `Service id check passed (admin: ${sorted(canonicalAdmin).join(', ')}; ` +
    `public: ${sorted(gatewayPublic).join(', ')}).`,
);
