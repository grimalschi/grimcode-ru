import { ESLint } from 'eslint';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = import.meta.dirname;
const eslint = new ESLint({ cwd: root });
async function messages(filePath, source) {
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages;
}

const boundaryError = expect.arrayContaining([
  expect.objectContaining({ ruleId: 'boundaries/dependencies' }),
]);

describe('architectural import boundaries', () => {
  it.each([
    ['modules/users/src/example.ts', "export type { AuthApi } from '@template/contracts/modules/auth';"],
    ['modules/auth/src/public/example.ts', "export { identitySchema } from '../schemas.js';"],
    ['modules/users/src/example.ts', "export { default } from 'pg';"],
    ['modules/users/src/example.mjs', "import process from 'node:process'; export const version = process.version;"],
    ['index.ts', "export { createModule } from '@template/auth';"],
  ])('allows %s: %s', async (file, source) => {
    expect(await messages(file, source)).toEqual([]);
  });

  it.each([
    ['modules/users/src/example.spec.ts', "export type { AuthEnv } from '@template/auth';"],
    ['modules/users/src/example.ts', "export { createModule } from '../../auth/src/index.js';"],
    ['modules/users/src/example.ts', "export const neighbour = import('@template/auth');"],
    ['modules/users/src/example.ts', "import '../../../index.js';"],
    ['modules/users/src/example.ts', "export * from '@template/contracts/modules/auth';"],
    // An inline type specifier leaves a runtime import with verbatimModuleSyntax.
    ['modules/users/src/example.ts', "import { type AuthApi } from '@template/contracts/modules/auth'; export type Api = AuthApi;"],
    ['contracts/src/example.ts', "export type { AuthEnv } from '../../modules/auth/src/index.js';"],
  ])('rejects %s: %s', async (file, source) => {
    expect(await messages(file, source)).toEqual(boundaryError);
  });

  it('resolves a local alias and rejects a neighbour when invoked from a module directory', () => {
    const run = (source) => spawnSync(process.execPath, [
      join(root, 'node_modules/eslint/bin/eslint.js'), '--stdin', '--stdin-filename', 'web/src/example.ts', '--format', 'json',
    ], { cwd: join(root, 'modules/notifications'), input: source, encoding: 'utf8', timeout: 10_000 });
    const own = run("export { cn } from '@/lib/utils';");
    expect(own.status, own.stderr).toBe(0);
    expect(JSON.parse(own.stdout)[0].messages).toEqual([]);
    const neighbour = run("export { createModule } from '@template/auth';");
    expect(neighbour.status, neighbour.stderr).toBe(1);
    expect(JSON.parse(neighbour.stdout)[0].messages).toEqual(boundaryError);
  });

  it('requires literal dynamic imports so their destination can be checked', async () => {
    expect(await messages('modules/users/src/example.ts', "const name = './index.js'; export const module = import(name);"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: 'no-restricted-syntax' })]));
  });
});

describe('module environment access', () => {
  it.each([
    ['modules/users/src/example.ts', 'export const value = process.env.DEMO;', 'no-restricted-properties'],
    ['modules/app/web/src/example.tsx', 'export const value = import.meta.env.VITE_API_URL;', 'no-restricted-syntax'],
    ['modules/users/src/example.mts', 'export const value = process.env.DEMO;', 'no-restricted-properties'],
    ['modules/users/src/example.js', 'export const value = process.env.DEMO;', 'no-restricted-properties'],
    ['modules/site/server/example.mjs', 'export const value = import.meta.env.DEMO;', 'no-restricted-syntax'],
  ])('rejects direct environment access in %s', async (file, source, ruleId) => {
    expect(await messages(file, source)).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId })]));
  });

  it('allows supplied configuration and module-local asset locations', async () => {
    expect(await messages('modules/users/src/example.ts', 'export const createModule = ({ env }) => ({ name: env.NAME, asset: new URL("./asset.json", import.meta.url) });'))
      .toEqual([]);
  });

  it.each([
    'index.ts',
    'scripts/example.mjs',
    'modules/users/src/example.spec.ts',
    'modules/users/web/src/example.test.tsx',
    'modules/site/vite.config.ts',
  ])('allows environment access in composition, tooling and tests: %s', async (file) => {
    expect(await messages(file, 'export const value = process.env.DEMO;')).toEqual([]);
  });
});
