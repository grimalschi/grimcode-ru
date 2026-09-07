/**
 * The boundary rules of the repository, written out in one place. Two checks read them and they are
 * the same rule seen from two sides: `check-boundaries.mjs` — what a file may import;
 * `check-dependencies.mjs` — what a manifest may declare. A rule that exists on only one of the two
 * sides is a rule with a door next to it. Neither is the first line of defence — pnpm, `rootDir` and
 * `references` are; these catch what those miss.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Which workspace packages each area may reach for.
 *
 * A `*` in an area makes every directory under it a compartment of its own, so a relative import
 * from `modules/admin` into `modules/auth` is a violation even though both match the same rule.
 *
 * An area is usually a directory; `index.ts` is one file, and deliberately. It is the program's
 * entry, and it holds the widest permission in the repository — affordable only while it contains
 * nothing but the order of calls, because the day it decides something, this line is the hole the
 * decision is made through. Naming the file rather than the root keeps the last rule closed: `.` is
 * also what anything unmatched falls back to, so widening it would hand the same permission to a
 * directory nobody has written a rule for yet.
 */
export const EVERY_PACKAGE = '*';

/**
 * The program's entry, as the rules and the checks refer to it — and its test beside it, because a
 * test and the file it tests have to be one compartment: the rule below also refuses a relative
 * import that leaves one.
 */
export const ENTRY_FILE = 'index.ts';
export const ENTRY_FILES = [ENTRY_FILE, 'index.test.ts'];

export const AREA_RULES = [
  { area: ENTRY_FILE, files: ENTRY_FILES, mayUse: EVERY_PACKAGE },
  { area: 'shared', mayUse: [] },
  { area: 'modules/*', mayUse: ['@template/shared'], neighbourSubpath: true },
  /*
   * The suite imports no module, and no longer the entry either: asking PostgreSQL which databases
   * exist needs their names, and it derives them from `PROJECT_SLUG` itself. That is the better test
   * anyway — importing the derivation would compare the code with itself.
   */
  /*
   * The database interface reaches for nothing of ours, and that is the point: it is meant to be
   * publishable on its own, and a single import of `@template/shared` would tie it to this
   * repository. Everything it needs — connection strings, a way to log — arrives as an argument.
   */
  { area: 'pg-interface', mayUse: [] },
  { area: 'tests', mayUse: ['@template/shared'] },
  { area: 'scripts', mayUse: [] },
  { area: '.', mayUse: [] },
];

/**
 * The one subpath a module may reach for in a neighbour: a tRPC client is typed from the server's
 * router, so six modules of seven have to see a type that lives in another.
 */
export const NEIGHBOUR_SUBPATH = 'contract';

export function allows(rule, packageName, specifier = packageName) {
  if (rule.mayUse === EVERY_PACKAGE || rule.mayUse.includes(packageName)) return true;
  return rule.neighbourSubpath === true && specifier === `${packageName}/${NEIGHBOUR_SUBPATH}`;
}

export function describeAllowance(rule) {
  if (rule.mayUse === EVERY_PACKAGE) return 'every workspace package';
  const named = rule.mayUse.length > 0 ? rule.mayUse.join(', ') : 'no workspace package';
  return rule.neighbourSubpath === true
    ? `${named}, and a neighbour only as @template/<name>/${NEIGHBOUR_SUBPATH}`
    : named;
}

/**
 * Packages that open a door out of the process, and who may hold each one.
 *
 * Written out one by one because this is not a class a check can recognise — a mail client added
 * tomorrow would have to be added by hand — and per package rather than as one list of homes, because
 * the two doors here are not the same door: a database driver and a server that opens a port have
 * nothing to do with each other, and a shared list would let whoever needs one hold the other.
 *
 * `pg`: it used to be `shared` alone, and the rule said what it meant — nothing but `shared` talks to
 * a database, and a module is handed a pool. `pg-interface` is the one home here that owns no database
 * and is on the list anyway: it is the panel's database interface, so looking at all of them at once is
 * its whole job. It opens its own small pools rather than borrowing a module's, which is what keeps a
 * heavy query typed into the console away from the pool a request needs. A module now opens its own, so the driver is its
 * dependency too. What that costs is worth stating: the check no longer says "only one package talks
 * to the database", it says "only a package that owns a database, or checks one, does". `app`, `site`
 * and `gateway` are still refused, and a new module that needs the driver has to be added here —
 * which is the moment to ask whether it really owns a database of its own. `tests` is here for the
 * one acceptance check that asks PostgreSQL directly which databases exist.
 *
 * `@hono/node-server`: this is what opens the port, and the process has one. It lived in `shared`
 * until 19 August, where every module could import it and open a port of its own with nothing to
 * refuse them; it then moved into the composer's manifest, which was a package, so a module reaching
 * for it had to declare it. The composer is a file at the root now, and the root's `node_modules` is
 * on every package's lookup path — so without this line the door would be open again, and silently.
 *
 * `modules/site` is on that list for a different reason and does not open anything: it serves the
 * built pages, and static file serving comes from the `/serve-static` subpath. A manifest cannot say
 * "only this subpath", so this half is the wider one — `check-boundaries.mjs` holds the other half
 * and refuses the bare specifier, the one that exports `serve`, anywhere but the entry.
 *
 * `@types/pg` is absent: types are erased at build time and open nothing.
 */
export const OUTSIDE_PROCESS_PACKAGES = {
  pg: [
    'shared',
    'tests',
    'pg-interface',
    'modules/admin',
    'modules/auth',
    'modules/email',
    'modules/notifications',
    'modules/users',
  ],
  '@hono/node-server': [ENTRY_FILE, 'modules/site'],
};

/**
 * The import that opens a port, and the only compartment allowed to write it. The subpath imports of
 * the same package — `@hono/node-server/serve-static` — cannot open one and are governed by the
 * manifest rule above.
 */
export const PORT_OPENING_IMPORT = '@hono/node-server';
export const PORT_OPENING_HOMES = [ENTRY_FILE];

/** Where a package that opens a door out of the process may be held, or an empty list. */
export function outsideProcessHomes(packageName) {
  return OUTSIDE_PROCESS_PACKAGES[packageName] ?? [];
}

/**
 * The compartment a repository-relative path belongs to, with the rule that governs it. `dir` is
 * what tells two modules apart under the same `modules/*` rule.
 */
export function compartmentOf(relative) {
  const segments = relative.split('/');

  for (const rule of AREA_RULES) {
    // A rule may name files instead of a directory; then the compartment is those files together.
    if (rule.files?.includes(relative)) return { rule, dir: rule.area };

    if (rule.area === '.') continue;
    const areaSegments = rule.area.split('/');
    const matches = areaSegments.every((segment, index) =>
      segment === '*' ? segments[index] !== undefined : segment === segments[index],
    );
    if (matches) {
      return { rule, dir: segments.slice(0, areaSegments.length).join('/') };
    }
  }

  return { rule: AREA_RULES.find((rule) => rule.area === '.'), dir: '.' };
}

/** Expands the `packages:` globs of `pnpm-workspace.yaml`; only a trailing `*` is supported. */
function workspaceGlobs() {
  const source = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const packages = /packages:\s*\n((?:\s*-\s*\S+\n?)+)/.exec(source);
  if (!packages) throw new Error('Could not find the packages list in pnpm-workspace.yaml');
  return [...packages[1].matchAll(/-\s*'?"?([^'"\s]+)'?"?/g)].map((entry) => entry[1]);
}

/**
 * Every workspace package, read from `pnpm-workspace.yaml` rather than hardcoded, so renaming
 * `modules/` is one edit in the manifest and not a second one here.
 */
export function workspacePackages() {
  const found = [];

  for (const glob of workspaceGlobs()) {
    const dirs = glob.endsWith('/*')
      ? readdirSync(join(repoRoot, glob.slice(0, -2)), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${glob.slice(0, -2)}/${entry.name}`)
      : [glob];

    for (const dir of dirs) {
      const manifestPath = join(repoRoot, dir, 'package.json');
      if (!statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      found.push({ name: manifest.name, dir, manifest });
    }
  }

  return found;
}
