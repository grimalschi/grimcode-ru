#!/usr/bin/env node
/**
 * Boundary check: what a file may import, and whether it reads the environment. The rules are in
 * `workspace-rules.mjs`, and the walk covers the whole repository, so `shared/` reaching into a
 * module is caught by the same rule as the reverse.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import {
  allows,
  compartmentOf,
  describeAllowance,
  PORT_OPENING_HOMES,
  PORT_OPENING_IMPORT,
  repoRoot,
  workspacePackages,
} from './workspace-rules.mjs';

const ignoredDirs = new Set([
  'node_modules',
  'dist',
  '.output',
  '.turbo',
  '.vite',
  'coverage',
  '.git',
  '.claude',
  '.idea',
  '.vscode',
  'playwright-report',
  'test-results',
]);
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * Areas forbidden to read the environment directly — the one boundary the move genuinely weakened,
 * because roles say nothing about credentials read out of `process.env`: a neighbour's
 * `DB_PASSWORD_<MODULE>` opens that neighbour's database, and `DATABASE_URL` opens every one of them
 * as the role that owns the server. The second line is in the composer, which deletes both once
 * handed out.
 */
const ENV_FORBIDDEN_AREAS = ['modules/*'];

/**
 * The door a neighbour comes through, and the one file that must carry nothing at runtime.
 * `exports` says which file may be opened and never what is inside, so this check says the rest: in
 * that one file, every export and every import must be type-only.
 */
const DOOR_FILE = /^modules\/[^/]+\/src\/contract\.ts$/;

/**
 * The two files a browser bundle may read from `shared`. A bundler follows imports, not manifests,
 * so one `import { intEnv } from './env.js'` and `process.env` follows it into a page, where the
 * failure is a blank screen and not a build error.
 */
const BROWSER_SAFE_FILES = /^shared\/src\/(theme|vocabulary)\.ts$/;
const BROWSER_SAFE_IMPORTS = new Set(['zod']);

/**
 * The one file of a module allowed to hold the driver, and the one that must check where it landed.
 *
 * A module opens its own database, so the driver has to live somewhere; the point is that it lives in
 * exactly one small file. One credential opens every database on the server, so a pool built anywhere
 * else — a repository, a router, a helper — could open a neighbour's with the same string and a
 * different name in it, and nothing downstream would notice.
 */
const DATABASE_FILE = /^modules\/[^/]+\/src\/db\/database\.ts$/;
const DATABASE_DRIVER = 'pg';

/**
 * What that file must do: ask the pool which database it actually opened. It is a guard, so on a
 * correct configuration it says nothing — which is why a module that forgets it looks healthy, and
 * why this check exists rather than a test.
 */
const DATABASE_ASSERTION = 'assertOpenedDatabase';

/**
 * The rest of what that file may contain, and why each line of it is here.
 *
 * The check above asks only whether the guard is called somewhere in the file, which is less than it
 * reads like. Measured on 26 August, all three of these pass it: a second pool built from the server
 * string with the path swapped for a neighbour's database; a pool whose string is
 * `env.databaseUrl.replace('_catalog', '_admin')` beside a guard told to expect that neighbour; and a
 * guard whose refusal is swallowed by `.catch(() => undefined)`. One credential opens every database
 * on the server, so each of those is a working connection to a neighbour that nothing refuses.
 *
 * Hence: the string is what the module was handed, verbatim; there are two pools, its database and the
 * server it lives on; and the guard is told to expect the name it was given, awaited on its own line
 * so a rejection cannot be caught and dropped.
 */
const POOL_CONNECTIONS = ['env.databaseUrl', 'env.maintenanceUrl'];
const POOLS_PER_DATABASE_FILE = 2;
const DATABASE_ASSERTION_EXPECTED = 'env.databaseName';

const packages = workspacePackages();
const packageNames = new Set(packages.map((entry) => entry.name));
const nameOfDir = new Map(packages.map((entry) => [entry.dir, entry.name]));

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) walk(full, files);
    } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

/** Repository-relative path with forward slashes, which is how the rule table is written. */
function repoRelative(file) {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

/**
 * The source file a relative specifier names.
 *
 * Under NodeNext a specifier says `./index.js` and the file on disk is `index.ts`. That only matters
 * where a compartment is a single file — the entry is one — because there the difference between
 * `index.js` and `index.ts` is the difference between "the same compartment" and "the root".
 */
function sourceOf(relative) {
  const compiled = /\.(js|mjs|cjs)$/.exec(relative);
  if (!compiled) return relative;

  for (const extension of ['ts', 'tsx', 'mts', 'cts']) {
    const candidate = relative.replace(/\.(js|mjs|cjs)$/, `.${extension}`);
    if (existsSync(path.join(repoRoot, candidate))) return candidate;
  }
  return relative;
}

function workspacePackageOf(specifier) {
  const scoped = /^(@[^/]+\/[^/]+)/.exec(specifier);
  const name = scoped ? scoped[1] : specifier.split('/')[0];
  return packageNames.has(name) ? name : null;
}

const importProblems = [];
const envProblems = [];
const doorProblems = [];
const emitProblems = [];
const unbuiltDoors = [];
const browserProblems = [];
const driverProblems = [];
const unguardedDatabases = [];
const poolProblems = [];
const listenerProblems = [];

function inspect(file) {
  const relative = repoRelative(file);
  const { rule, dir } = compartmentOf(relative);
  const ownName = nameOfDir.get(dir) ?? null;

  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

  const at = (node) => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${relative}:${position.line + 1}:${position.character + 1}`;
  };

  const literal = (node) => (node && ts.isStringLiteralLike(node) ? node.text : null);

  const recordImport = (node, specifier, kind) => {
    const target = workspacePackageOf(specifier);

    if (target) {
      if (target === ownName || allows(rule, target, specifier)) return;
      importProblems.push(
        `${at(node)} ${kind} of "${specifier}": ${rule.area} may use ${describeAllowance(rule)}`,
      );
      return;
    }

    if (!specifier.startsWith('.')) return;

    const resolved = sourceOf(repoRelative(path.resolve(path.dirname(file), specifier)));
    if (resolved.startsWith('..')) return;

    const there = compartmentOf(resolved);
    if (there.dir === dir) return;

    importProblems.push(
      `${at(node)} ${kind} of "${specifier}" leaves ${dir} and lands in ${there.dir}; ` +
        'reach a package by its name, not by a relative path',
    );
  };

  const readsEnvironment =
    ENV_FORBIDDEN_AREAS.includes(rule.area) && !/\.test\.tsx?$/.test(relative);

  const visit = (node) => {
    if (
      readsEnvironment &&
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'env' &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process'
    ) {
      envProblems.push(`${at(node)} reads process.env in ${dir}`);
    }

    if (ts.isImportDeclaration(node)) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier) {
        recordImport(node, specifier, node.importClause?.isTypeOnly ? 'type import' : 'import');
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier) recordImport(node, specifier, 're-export');
    } else if (ts.isCallExpression(node)) {
      const specifier = literal(node.arguments[0]);
      if (specifier && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        recordImport(node, specifier, 'dynamic import');
      }
      if (specifier && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        recordImport(node, specifier, 'require');
      }
    }
    ts.forEachChild(node, visit);
  };

  if (DOOR_FILE.test(relative)) {
    inspectDoor(relative, source, at);
    inspectDoorEmit(relative);
  }

  /*
   * The port is the program's, not a module's. The manifest rule cannot say this on its own — it
   * cannot distinguish `@hono/node-server` from `@hono/node-server/serve-static`, and the site needs
   * the second one — so the exact specifier is refused here instead.
   */
  if (!PORT_OPENING_HOMES.includes(dir)) {
    for (const statement of source.statements) {
      const specifier = ts.isImportDeclaration(statement) ? literalOf(statement.moduleSpecifier) : null;
      if (specifier === PORT_OPENING_IMPORT) {
        listenerProblems.push(`${at(statement)} imports "${specifier}" in ${dir}`);
      }
    }
  }

  if (rule.area === 'modules/*' && !/\.test\.tsx?$/.test(relative) && !DATABASE_FILE.test(relative)) {
    for (const statement of source.statements) {
      const specifier = ts.isImportDeclaration(statement) ? literalOf(statement.moduleSpecifier) : null;
      if (specifier === DATABASE_DRIVER) {
        driverProblems.push(`${at(statement)} imports "${DATABASE_DRIVER}" in ${dir}`);
      }
    }
  }

  if (DATABASE_FILE.test(relative)) {
    const pools = [];
    const guards = [];

    const inspectDatabaseFile = (node) => {
      if (ts.isNewExpression(node) && node.expression.getText(source) === `${DATABASE_DRIVER}.Pool`) {
        pools.push(node);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === DATABASE_ASSERTION
      ) {
        guards.push(node);
      }
      ts.forEachChild(node, inspectDatabaseFile);
    };
    inspectDatabaseFile(source);

    if (guards.length === 0) unguardedDatabases.push(relative);

    if (pools.length > POOLS_PER_DATABASE_FILE) {
      poolProblems.push(
        `${relative} builds ${pools.length} pools; ${POOLS_PER_DATABASE_FILE} are its own database ` +
          'and the server it lives on',
      );
    }

    for (const pool of pools) {
      const options = pool.arguments?.[0];
      const property =
        options && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (entry) =>
                ts.isPropertyAssignment(entry) && entry.name.getText(source) === 'connectionString',
            )
          : undefined;
      const written = property ? property.initializer.getText(source) : null;

      if (written === null) {
        poolProblems.push(`${at(pool)} builds a pool without a connectionString this check can read`);
      } else if (!POOL_CONNECTIONS.includes(written)) {
        poolProblems.push(`${at(pool)} connects to \`${written}\`, which is not what it was handed`);
      }
    }

    for (const guard of guards) {
      const expected = guard.arguments[1] ? guard.arguments[1].getText(source) : null;
      if (expected !== DATABASE_ASSERTION_EXPECTED) {
        poolProblems.push(
          `${at(guard)} checks against \`${expected ?? 'nothing'}\` instead of ` +
            `\`${DATABASE_ASSERTION_EXPECTED}\``,
        );
      }

      // Its own statement, so a rejection cannot be caught and dropped on the way.
      const awaited =
        ts.isAwaitExpression(guard.parent) && ts.isExpressionStatement(guard.parent.parent);
      if (!awaited) {
        poolProblems.push(`${at(guard)} is not awaited on its own line, so its refusal can be lost`);
      }
    }
  }

  if (BROWSER_SAFE_FILES.test(relative)) {
    for (const statement of source.statements) {
      const specifier =
        (ts.isImportDeclaration(statement) || (ts.isExportDeclaration(statement) && statement.moduleSpecifier))
          ? literalOf(statement.moduleSpecifier)
          : null;
      if (specifier && !BROWSER_SAFE_IMPORTS.has(specifier)) {
        browserProblems.push(`${at(statement)} imports "${specifier}"`);
      }
    }
  }

  visit(source);
}

/** The string of a module specifier node, or null when it is not a plain literal. */
function literalOf(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

/**
 * Everything in the door must be a declaration. `export { AuthPublicRouter }` without `type` is the
 * case worth naming: it looks identical in the editor and type-checks, but the emitted file keeps
 * the re-export, so the door starts pulling `./routers/public.js` into whoever opened it.
 */
function inspectDoor(relative, source, at) {
  const say = (node, what) => doorProblems.push(`${at(node)} ${what}`);

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.isTypeOnly) say(statement, 'export is not type-only — write `export type {…}`');
      continue;
    }

    if (ts.isImportDeclaration(statement)) {
      if (!statement.importClause?.isTypeOnly) {
        say(statement, 'import is not type-only — write `import type {…}`');
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      say(statement, 'default export — the door exports declarations, not values');
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) continue;

    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      say(statement, 'exports a value — only types may leave through the door');
    }
  }
}

/**
 * The same rule from the other side: not how the door is written, but what it emits.
 *
 * The check above reads the source and knows the forms that would carry code; this one knows none of
 * them and asks the built file to be `export {};`. That covers what a list of forms cannot: a `const`
 * nobody exports, written to derive a type from it, exports nothing and still emits the value.
 *
 * It runs after `build`, which is where it sits in `pnpm check`. Standing alone it refuses rather
 * than skips: a check that quietly does nothing is worse than one that says it cannot run.
 */
function inspectDoorEmit(relative) {
  const built = relative.replace('/src/', '/dist/').replace(/\.ts$/, '.js');
  const full = path.join(repoRoot, built);

  let emitted;
  try {
    emitted = readFileSync(full, 'utf8');
  } catch {
    unbuiltDoors.push(built);
    return;
  }

  const code = emitted
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//'))
    .join(' ');

  if (code !== 'export {};') emitProblems.push(`${built} emits ${JSON.stringify(code)}`);
}

const files = walk(repoRoot);
for (const file of files) inspect(file);

if (importProblems.length > 0) {
  console.error('Imports that cross a boundary:');
  for (const problem of importProblems) console.error(`- ${problem}`);
  console.error(
    '\nUse @template/shared, or a neighbour as @template/<name>/contract, and call through it.',
  );
}

if (envProblems.length > 0) {
  const separator = importProblems.length > 0 ? '\n' : '';
  console.error(`${separator}Modules reading the environment:`);
  for (const problem of envProblems) console.error(`- ${problem}`);
  console.error('\nA module is handed what it needs; the composer is what reads the environment.');
}

if (browserProblems.length > 0) {
  const earlier = importProblems.length > 0 || envProblems.length > 0;
  console.error(`${earlier ? '\n' : ''}Browser-facing files reaching into the server:`);
  for (const problem of browserProblems) console.error(`- ${problem}`);
  console.error(
    `\n${'shared/src/theme.ts and shared/src/vocabulary.ts are published to browser bundles; '}` +
      'they may import zod and nothing else, or pg and process.env follow them into a page.',
  );
}

if (driverProblems.length > 0) {
  const earlier = importProblems.length > 0 || envProblems.length > 0 || browserProblems.length > 0;
  console.error(`${earlier ? '\n' : ''}Modules holding the database driver outside their own db file:`);
  for (const problem of driverProblems) console.error(`- ${problem}`);
  console.error(
    `\nA module opens its own database in src/db/database.ts and nowhere else. One credential opens ` +
      'every database on the server, so a second pool built elsewhere could open a neighbour\'s.',
  );
}

if (listenerProblems.length > 0) {
  const earlier =
    importProblems.length > 0 ||
    envProblems.length > 0 ||
    browserProblems.length > 0 ||
    driverProblems.length > 0;
  console.error(`${earlier ? '\n' : ''}Files that could open a port of their own:`);
  for (const problem of listenerProblems) console.error(`- ${problem}`);
  console.error(
    `\nOnly ${PORT_OPENING_HOMES.join(', ')} may import ${PORT_OPENING_IMPORT}: the process has one ` +
      'listener, and everything reachable from outside passes Gateway because that listener is the ' +
      'only one. The `/serve-static` subpath opens nothing and is not this rule.',
  );
}

if (unguardedDatabases.length > 0) {
  console.error(`\nModule databases opened without checking which one answered:`);
  for (const file of unguardedDatabases) console.error(`- ${file}`);
  console.error(
    `\nEach must call ${DATABASE_ASSERTION} before it uses the pool. It is a guard: on a correct ` +
      'configuration it says nothing, so a module that forgets it looks healthy until it writes into ' +
      "a neighbour's database.",
  );
}

if (poolProblems.length > 0) {
  console.error(`\nPools built from something other than what the module was handed:`);
  for (const problem of poolProblems) console.error(`- ${problem}`);
  console.error(
    `\nA module opens its own database and the server it lives on — ${POOL_CONNECTIONS.join(' or ')}, ` +
      `as written — and tells the guard the name it was given: ` +
      `\`await ${DATABASE_ASSERTION}(pool, ${DATABASE_ASSERTION_EXPECTED});\`. One credential opens ` +
      'every database on the server, so a string assembled here, a third pool, or a guard told to ' +
      "expect something else is a connection to a neighbour's database that nothing refuses.",
  );
}

if (doorProblems.length > 0) {
  const earlier = importProblems.length > 0 || envProblems.length > 0;
  console.error(`${earlier ? '\n' : ''}Doors that would carry code:`);
  for (const problem of doorProblems) console.error(`- ${problem}`);
  console.error(
    '\nmodules/*/src/contract.ts is the only file a neighbour may import; it must compile to ' +
      '`export {};` so the type crosses the boundary and the implementation does not.',
  );
}

const earlierProblem = () =>
  importProblems.length > 0 ||
  envProblems.length > 0 ||
  doorProblems.length > 0 ||
  browserProblems.length > 0 ||
  driverProblems.length > 0 ||
  listenerProblems.length > 0 ||
  unguardedDatabases.length > 0 ||
  poolProblems.length > 0;

if (emitProblems.length > 0) {
  console.error(`${earlierProblem() ? '\n' : ''}Doors that carry code once built:`);
  for (const problem of emitProblems) console.error(`- ${problem}`);
  console.error(
    '\nA door is allowed to emit `export {};` and nothing else. Whatever is left in it runs when ' +
      'a neighbour loads the door, and travels into every bundle that follows the type.',
  );
}

if (unbuiltDoors.length > 0) {
  console.error(`${earlierProblem() || emitProblems.length > 0 ? '\n' : ''}Doors not built yet:`);
  for (const door of unbuiltDoors) console.error(`- ${door}`);
  console.error('\nWhat a door emits is only visible after pnpm build; run it and repeat.');
}

if (earlierProblem() || emitProblems.length > 0 || unbuiltDoors.length > 0) {
  process.exit(1);
}

console.log(`Boundary check passed (${packages.length} packages, ${files.length} files).`);
