#!/usr/bin/env node
/**
 * Reconciles the three explicit declarations of admin service ids:
 *
 * - `shared/src/vocabulary.ts`        — the canonical lists
 * - `modules/gateway/src/registry.ts` — what Gateway is willing to proxy
 * - `modules/admin/web/src/services.ts` — what the central Admin shell shows
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

function constArray(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`, 's').exec(source);
  if (!match) throw new Error(`Could not find the declaration of ${name}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

function objectKeys(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*\\{(.*?)\\n\\}`, 's').exec(source);
  if (!match) throw new Error(`Could not find the declaration of ${name}`);
  return [...match[1].matchAll(/^\s{2}([a-z][a-zA-Z0-9]*):/gm)].map((entry) => entry[1]);
}

const contracts = read('shared/src/vocabulary.ts');
const gateway = read('modules/gateway/src/registry.ts');
const shell = read('modules/admin/web/src/services.ts');

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

/*
 * The database section is owner-only and must never become a service id. The name it is refused
 * under used to be `adminer`, after the third-party application behind it; the application is gone
 * and the rule is not — it is the area's own name that has to stay unclaimable.
 */
if (canonicalAdmin.includes('database')) {
  problems.push(
    'The database section is listed as an admin service. It is a section of the Admin panel, not a ' +
      'service: it reads every service’s data at once, which is why no grant can name it.',
  );
}

if (gatewayPublic.includes('database')) {
  problems.push("The database section must never appear in Gateway's public allowlist");
}
if (canonicalAssignable.includes('database')) {
  problems.push('The database section must never be an assignable service grant');
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
