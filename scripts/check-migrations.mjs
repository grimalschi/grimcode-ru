#!/usr/bin/env node
/**
 * Every migration file is listed, numbered once, and named after what it is.
 *
 * A module's migrations are a folder now, one file each, and the list in `index.ts` is what the
 * migrator actually runs. That split is what keeps a machine-written migration away from the text of
 * a hand-written one — and it opens exactly one hole: a file that exists but is in no list. Nothing
 * at runtime would notice. The database would simply never receive it, on this machine and on every
 * other one, and the first sign would be a query failing against a column that was supposed to exist.
 *
 * The rest is bookkeeping that only ever goes wrong the same three ways: a version used twice, a
 * version out of order, a file whose name says one thing and whose contents say another.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** `interface-<kind>-<schema>-<table>-<column>`, and a rename carries the new name after it. */
const IDENTIFIER = '[A-Za-z_][A-Za-z0-9_]*';
const INTERFACE_NAME = new RegExp(
  `^interface-(add|drop)-${IDENTIFIER}-${IDENTIFIER}-${IDENTIFIER}$|` +
    `^interface-rename-${IDENTIFIER}-${IDENTIFIER}-${IDENTIFIER}-${IDENTIFIER}$`,
);

const problems = [];
let counted = 0;

const modules = readdirSync(join(repoRoot, 'modules'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const module of modules) {
  const folder = join(repoRoot, 'modules', module, 'src/db/migrations');
  if (!existsSync(folder)) continue;

  const indexPath = join(folder, 'index.ts');
  if (!existsSync(indexPath)) {
    problems.push(`${module}: src/db/migrations has no index.ts, so nothing there is ever applied`);
    continue;
  }

  const index = readFileSync(indexPath, 'utf8');

  // What the index imports, in the order it imports them: `import { migration as v1 } from './001-x.js'`.
  const imported = [...index.matchAll(/import\s*\{\s*migration as (\w+)\s*\}\s*from\s*'\.\/([^']+)\.js'/g)].map(
    (match) => ({ alias: match[1], file: `${match[2]}.ts` }),
  );

  // What it hands the migrator. Order here is the order they run, so it is compared, not sorted.
  const listed = /migrations:\s*readonly Migration\[\]\s*=\s*\[([^\]]*)\]/s.exec(index);
  if (!listed) {
    problems.push(`${module}: index.ts does not export a migrations array this check can read`);
    continue;
  }
  const runs = [...listed[1].matchAll(/[\w$]+/g)].map((match) => match[0]);

  const onDisk = readdirSync(folder)
    .filter((name) => name.endsWith('.ts') && name !== 'index.ts')
    .sort();

  for (const file of onDisk) {
    if (!imported.some((entry) => entry.file === file)) {
      problems.push(`${module}: ${file} is in the folder but in no list — it would never be applied`);
    }
  }

  for (const entry of imported) {
    if (!existsSync(join(folder, entry.file))) {
      problems.push(`${module}: index.ts imports ${entry.file}, which does not exist`);
    }
  }

  if (JSON.stringify(runs) !== JSON.stringify(imported.map((entry) => entry.alias))) {
    problems.push(
      `${module}: the migrations array [${runs}] is not what index.ts imports ` +
        `[${imported.map((entry) => entry.alias)}], in that order`,
    );
  }

  let previous = 0;
  for (const entry of imported) {
    const source = existsSync(join(folder, entry.file))
      ? readFileSync(join(folder, entry.file), 'utf8')
      : '';
    const version = Number(/version:\s*(\d+)/.exec(source)?.[1]);
    const name = /name:\s*'([^']+)'/.exec(source)?.[1];

    if (!Number.isInteger(version) || !name) {
      problems.push(`${module}/${entry.file}: no single migration with a version and a name in it`);
      continue;
    }

    const expected = `${String(version).padStart(3, '0')}-${name}.ts`;
    if (entry.file !== expected) {
      problems.push(`${module}/${entry.file}: version ${version} and name "${name}" say ${expected}`);
    }

    if (version <= previous) {
      problems.push(`${module}/${entry.file}: version ${version} does not follow ${previous}`);
    }

    /*
     * A migration written by the database section carries what it did in its name, and that name is
     * the only record of which columns that section may rename or drop later. One written wrong is
     * ownership lost in silence — the column stays, and the screen simply stops offering to touch it.
     * The shape is repeated here rather than imported: a check reaches for nothing of the repository.
     */
    if (name.startsWith('interface-') && !INTERFACE_NAME.test(name)) {
      problems.push(
        `${module}/${entry.file}: "${name}" looks like a change made from the database section, ` +
          'but does not read back as one (interface-add|rename|drop-schema-table-column[-to])',
      );
    }

    previous = version;
    counted += 1;
  }
}

if (problems.length > 0) {
  console.error('Migrations that would not run as written:');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log(`Migrations checked (${counted} in ${modules.length} modules).`);
