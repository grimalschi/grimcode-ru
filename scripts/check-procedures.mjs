#!/usr/bin/env node
/**
 * How a procedure is declared: what it promises to return, and what it demands before it changes
 * anything.
 *
 * Both rules held perfectly before this check existed, and that is exactly the problem: they held
 * because fifty-seven procedures were written the same way, one after another. Nothing was watching
 * the fifty-eighth.
 *
 * **Every procedure declares its output.** tRPC calls output validation optional, and for a return
 * value that stays inside one program it is. Here every procedure hands data across a module
 * boundary, so the case the documentation treats as the exception is all of them. The compiler does
 * not cover it: excess property checking works on literals, and a resolver returns a variable — a
 * repository row with a password hash in it satisfies a narrower declared type.
 *
 * **Every admin procedure that changes something demands a CSRF token.** Not by being named
 * `adminMutation` — the builder is followed to its definition and asked whether `requireCsrf` is
 * anywhere in the middleware it is built from. A builder named right and wired wrong is the failure
 * this is written against.
 *
 * Which surface a router answers on is not guessed from its variable name either: it is read from
 * the `mountTrpc` call that mounts it, or — for an internal router a neighbour calls directly — from
 * the `createCallerFactory` it is handed to. A router with neither is reported rather than skipped,
 * because a surface reached in a way this check cannot see is one it cannot judge. The CSRF rule
 * keys off the mount prefix and so applies to neither: a direct call carries no browser and no form.
 *
 * The same rule applies inside a router. `{ name: builder… }` and `{ name }` beside a `const` are
 * one procedure written two ways, and both are followed; a form that is neither is reported. Before
 * that, the shorthand passed through in silence — with no `.output()` demanded, no CSRF demanded and
 * the procedure missing from the count, which is the one outcome worse than a red run.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { repoRoot } from './workspace-rules.mjs';

const MODULES = path.join(repoRoot, 'modules');
const CSRF_GUARD = 'requireCsrf';

const outputProblems = [];
const csrfProblems = [];
const unmountedRouters = [];
const unreadable = [];

function moduleSources(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', 'web', '.turbo'].includes(entry.name)) walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        found.push(full);
      }
    }
  };
  const src = path.join(dir, 'src');
  if (statSync(src, { throwIfNoEntry: false })?.isDirectory()) walk(src);
  return found;
}

function parse(file) {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

/** `{…} satisfies Record<Name, unknown>` and friends, down to the literal underneath. */
function unwrap(node) {
  let current = node;
  while (
    ts.isSatisfiesExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The method names of a call chain, outermost last, and the expression it was built from. */
function chainOf(node) {
  const methods = [];
  let base = node;
  while (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression)) {
    methods.unshift(base.expression.name.text);
    base = base.expression.expression;
  }
  return { methods, base };
}

/**
 * Routers this module hands to `createCallerFactory`, so a neighbour calls their procedures
 * directly instead of over a path. Such a router answers nowhere and is still reachable, which is
 * why an absent mount is not by itself a fault.
 */
function callerRoutersOf(files, source) {
  const called = new Set();

  for (const file of files) {
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'createCallerFactory' &&
        node.arguments.length === 1 &&
        ts.isIdentifier(node.arguments[0])
      ) {
        called.add(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source(file));
  }

  return called;
}

/** Where each router of one module is mounted, by the prefix given to `mountTrpc`. */
function mountsOf(files, source) {
  const mounts = new Map();

  for (const file of files) {
    if (path.basename(file) !== 'index.ts') continue;
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'mountTrpc' &&
        node.arguments.length >= 3 &&
        ts.isStringLiteralLike(node.arguments[1]) &&
        ts.isIdentifier(node.arguments[2])
      ) {
        mounts.set(node.arguments[2].text, node.arguments[1].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source(file));
  }

  return mounts;
}

/**
 * Whether a builder demands a CSRF token, following it to its definition.
 *
 * `adminMutation` is `adminProcedure.use(…)`, and `adminProcedure` is `t.procedure.use(…)`; the
 * guard may sit in either link, so the whole chain is walked. `seen` is not caution — a builder that
 * refers to itself would otherwise hang the check rather than fail it.
 */
function demandsCsrf(name, declarations, seen = new Set()) {
  if (seen.has(name)) return false;
  seen.add(name);

  const initializer = declarations.get(name);
  if (!initializer) return false;

  let found = false;
  const look = (node) => {
    if (ts.isIdentifier(node) && node.text === CSRF_GUARD) found = true;
    ts.forEachChild(node, look);
  };

  const { methods, base } = chainOf(initializer);
  if (methods.includes('use')) look(initializer);

  return found || (ts.isIdentifier(base) ? demandsCsrf(base.text, declarations, seen) : false);
}

let procedures = 0;
let adminMutations = 0;

for (const entry of readdirSync(MODULES, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(MODULES, entry.name);
  const files = moduleSources(dir);

  const parsed = new Map(files.map((file) => [file, parse(file)]));
  const source = (file) => parsed.get(file);
  const mounts = mountsOf(files, source);
  const callerRouters = callerRoutersOf(files, source);
  const mountedRouters = new Set();

  for (const file of files) {
    const tree = parsed.get(file);
    const relative = path.relative(repoRoot, file).split(path.sep).join('/');

    /** Every `const x = …` in the file, so a builder can be followed to what it is made of. */
    const declarations = new Map();
    const collect = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        declarations.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, collect);
    };
    collect(tree);

    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'router' &&
        node.arguments.length > 0
      ) {
        const literal = unwrap(node.arguments[0]);
        if (ts.isObjectLiteralExpression(literal)) {
          const routerName =
            node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
              ? node.parent.name.text
              : null;
          const prefix = routerName ? mounts.get(routerName) : undefined;
          if (routerName && prefix !== undefined) mountedRouters.add(routerName);
          if (routerName && prefix === undefined && !callerRouters.has(routerName)) {
            unmountedRouters.push(`${relative} ${routerName}`);
          }

          for (const property of literal.properties) {
            const line =
              tree.getLineAndCharacterOfPosition(property.getStart(tree)).line + 1;

            /*
             * `{ listEvents: … }` and `{ listEvents }` are the same procedure to tRPC and two
             * different nodes to the parser, so the shorthand is followed to the `const` it names.
             * Anything else — a spread, a method, a name declared in another file — is reported
             * rather than skipped: an entry this check cannot read is an entry it cannot judge.
             */
            const initializer = ts.isPropertyAssignment(property)
              ? property.initializer
              : ts.isShorthandPropertyAssignment(property)
                ? declarations.get(property.name.text)
                : undefined;

            if (initializer === undefined) {
              unreadable.push(`${relative}:${line} ${property.getText(tree).split('\n')[0]}`);
              continue;
            }

            const name = ts.isPropertyAssignment(property)
              ? property.name.getText(tree)
              : property.name.text;
            const { methods, base } = chainOf(initializer);
            const where = `${relative}:${line} ${name}`;

            procedures += 1;
            if (!methods.includes('output')) {
              outputProblems.push(`${where} has no .output()`);
            }

            const changes = methods.includes('mutation');
            const onAdminSurface = prefix !== undefined && prefix.startsWith('/admin');
            if (changes && onAdminSurface) {
              adminMutations += 1;
              const builder = ts.isIdentifier(base) ? base.text : base.getText(tree);
              if (!ts.isIdentifier(base) || !demandsCsrf(base.text, declarations)) {
                csrfProblems.push(`${where} changes something on ${prefix}, built on ${builder}`);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
}

if (outputProblems.length > 0) {
  console.error('Procedures that do not declare what they return:');
  for (const problem of outputProblems) console.error(`- ${problem}`);
  console.error(
    '\nEvery procedure hands data across a module boundary, so every one declares its output. ' +
      'The compiler does not cover this: a resolver returns a variable, and excess properties on a ' +
      'variable are not checked.',
  );
}

if (csrfProblems.length > 0) {
  console.error(`${outputProblems.length > 0 ? '\n' : ''}Admin changes that ask for no CSRF token:`);
  for (const problem of csrfProblems) console.error(`- ${problem}`);
  console.error(
    `\nBuild them on a builder that pipes ${CSRF_GUARD} in. A read may stay on the plain admin ` +
      'builder; a change may not, or the admin panel is one forged form away.',
  );
}

if (unreadable.length > 0) {
  const earlier = outputProblems.length > 0 || csrfProblems.length > 0;
  console.error(`${earlier ? '\n' : ''}Router entries this check could not read:`);
  for (const entry of unreadable) console.error(`- ${entry}`);
  console.error(
    '\nA procedure is written as `name: builder…`, or as `{ name }` beside a `const` in the same ' +
      'file. Anything else — a spread, a method, a name from another module — leaves the two rules ' +
      'above unchecked, and silence would look exactly like passing.',
  );
}

if (unmountedRouters.length > 0) {
  const earlier = outputProblems.length > 0 || csrfProblems.length > 0;
  console.error(`${earlier ? '\n' : ''}Routers that are never mounted:`);
  for (const router of unmountedRouters) console.error(`- ${router}`);
  console.error(
    '\nWhich surface a router answers on is read from its mountTrpc call, or from the ' +
      'createCallerFactory that hands it to a neighbour. With neither, it either answers nowhere ' +
      'or is reached in a way this check cannot see; neither should pass quietly.',
  );
}

if (
  outputProblems.length > 0 ||
  csrfProblems.length > 0 ||
  unreadable.length > 0 ||
  unmountedRouters.length > 0
) {
  process.exit(1);
}

console.log(
  `Procedure check passed (${procedures} procedures, ${adminMutations} admin changes behind CSRF).`,
);
