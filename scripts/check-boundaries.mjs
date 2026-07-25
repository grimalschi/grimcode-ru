#!/usr/bin/env node
/**
 * Service boundary check.
 *
 * A service may import its own folder, `contracts/`, `shared/` and external packages. Importing a
 * neighbouring service is forbidden — including type-only imports, because a shared type between
 * two services belongs in `contracts/`. Cross-service communication goes over HTTP/oRPC.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const servicesRoot = path.join(repoRoot, 'services');
const ignoredDirs = new Set(['node_modules', 'dist', '.output', '.turbo', '.vite', 'coverage']);
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

if (!existsSync(servicesRoot)) {
  console.error('services/ directory not found');
  process.exit(1);
}

const services = new Set(
  readdirSync(servicesRoot).filter((name) =>
    statSync(path.join(servicesRoot, name)).isDirectory(),
  ),
);

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

function serviceOf(file) {
  const relative = path.relative(servicesRoot, file);
  const [name] = relative.split(path.sep);
  return services.has(name) ? name : null;
}

/** Resolves an import specifier to the service it belongs to, or null. */
function targetServiceOf(file, specifier) {
  const scoped = /^@template\/([^/]+)/.exec(specifier);
  if (scoped && services.has(scoped[1])) return scoped[1];

  if (!specifier.startsWith('.')) return null;

  const resolved = path.resolve(path.dirname(file), specifier);
  const relative = path.relative(servicesRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;

  const [name] = relative.split(path.sep);
  return services.has(name) ? name : null;
}

function inspect(file) {
  const current = serviceOf(file);
  if (!current) return [];

  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const violations = [];

  const record = (node, specifier, kind) => {
    const target = targetServiceOf(file, specifier);
    if (!target || target === current) return;
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push({
      file,
      at: `${position.line + 1}:${position.character + 1}`,
      kind,
      current,
      target,
      specifier,
    });
  };

  const literal = (node) => (node && ts.isStringLiteralLike(node) ? node.text : null);

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier) record(node, specifier, node.importClause?.isTypeOnly ? 'type import' : 'import');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier) record(node, specifier, 're-export');
    } else if (ts.isCallExpression(node)) {
      const specifier = literal(node.arguments[0]);
      if (specifier && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        record(node, specifier, 'dynamic import');
      }
      if (specifier && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        record(node, specifier, 'require');
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return violations;
}

const violations = walk(servicesRoot).flatMap(inspect);

if (violations.length > 0) {
  console.error('Forbidden imports between services:');
  for (const violation of violations) {
    console.error(
      `- ${path.relative(repoRoot, violation.file)}:${violation.at} ${violation.kind} ` +
        `from "${violation.current}" to "${violation.target}" via "${violation.specifier}"`,
    );
  }
  console.error('\nUse @template/contracts or @template/shared, and call over HTTP/oRPC.');
  process.exit(1);
}

console.log(`Service boundary check passed (${services.size} services).`);
