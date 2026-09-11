import js from '@eslint/js';
import { globSync } from 'node:fs';
import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const root = import.meta.dirname;

export default tseslint.config(
  { ignores: ['**/{dist,.turbo,coverage}/**', '**/routeTree.gen.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['modules/**/*.{ts,tsx,mts,js,mjs}', 'contracts/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'boundaries/root-path': root,
      'boundaries/elements': [
        { type: 'module', pattern: 'modules/*', partialMatch: false },
        { type: 'contracts', pattern: 'contracts', partialMatch: false },
      ],
      'import/resolver': {
        typescript: {
          // Resolve from the repository, regardless of the package that invoked ESLint.
          project: globSync([
            'tsconfig.entry.json', 'modules/*/tsconfig.json', 'modules/*/web/tsconfig.json',
          ], { cwd: root }).map((file) => `${root}/${file}`),
          noWarnOnMultipleProjects: true,
        },
      },
    },
    rules: {
      'boundaries/dependencies': ['error', {
        checkAllOrigins: true, checkUnknownLocals: true, checkInternals: false,
        policies: [
          // Own files and external libraries; workspace imports need an explicit permission below.
          { allow: { to: { module: { origin: ['external', 'core'] } } },
            disallow: { dependency: { source: '@template/**' } },
          },
          { from: { element: { type: 'module' } }, dependency: { kind: 'type' }, allow: [
            { to: { element: { type: 'contracts' } } },
            { dependency: { source: '@template/contracts/**' } },
          ] },
        ],
      }],
    },
  },
  {
    files: ['modules/*/{src,web/src,server}/**/*.{ts,tsx,mts,js,mjs}'],
    ignores: ['**/*.{test,spec}.{ts,tsx,mts,js,mjs}'],
    rules: {
      'no-restricted-properties': ['error', {
        object: 'process', property: 'env', message: 'Receive configuration through createModule({ env }).',
      }],
      'no-restricted-syntax': ['error', {
        selector: "MemberExpression[object.meta.name='import']:matches([property.name='env'], [property.value='env'])",
        message: 'Receive configuration through createModule({ env }).',
      }, {
        selector: "ImportExpression[source.type!='Literal']",
        message: 'Use literal imports so module boundaries can be checked.',
      }],
    },
  },
  {
    files: ['**/web/src/**/*.{ts,tsx}', 'modules/site/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
