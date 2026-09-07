import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.output/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/routeTree.gen.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/*'],
              message:
                'Modules must not import each other. Use @template/contracts, or a neighbour as @template/<name>/contract.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  /*
   * A module does not read the environment; the directives in `AGENTS.md` say so. It does open its
   * own pool, from the connection string the composer put on `c.env` — which is a different thing
   * from naming a variable.
   *
   * `check-boundaries` refuses the expression `process.env` here. What it cannot see is the way around
   * it — asking `shared` to read a name for you — because then the reading happens in `shared` and the
   * module only passes a string. Measured: `optionalEnv('DATABASE_URL', '')` inside a module passes that
   * check with exit code 0. Hence these two refusals.
   *
   * The named readers stay allowed: `publicSiteUrl` and `sessionCookieName` carry their variable inside
   * them, so a module holding one cannot reach anything else with it. `pg` is not refused either — a
   * module calls the driver itself, and who may declare it is `check-dependencies`, by manifest.
   *
   * The neighbour-import ban is repeated here because rules replace rather than merge: listing only
   * `paths` would silently drop the `patterns` above, where it matters most.
   */
  {
    files: ['modules/*/src/**/*.{ts,tsx}', 'modules/*/web/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@template/shared',
              importNames: ['optionalEnv', 'requireEnv', 'intEnv'],
              message:
                'A module is handed its settings and its connection string by the composer, on c.env, and reads the environment through nothing else. Open your own pool from c.env, as each module does in its own src/db/database.ts.',
            },
          ],
          patterns: [
            {
              group: ['**/modules/*'],
              message:
                'Modules must not import each other. Use @template/contracts, or a neighbour as @template/<name>/contract.',
            },
          ],
        },
      ],
      /*
       * `no-restricted-globals` refuses `process` as a free identifier, which covers `process.env`,
       * `process['env']` and `const { env } = process`. It does not cover `globalThis.process`,
       * because there the name is a property and not a global reference — so the syntax rule below
       * names the identifier wherever it appears.
       */
      'no-restricted-globals': [
        'error',
        {
          name: 'process',
          message:
            'A module does not touch process. The composer reads the environment and hands over what this module needs.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "Identifier[name='process']",
          message:
            'A module does not touch process, by any route — `globalThis.process` included. The composer reads the environment; this module receives what it needs on `c.env`.',
        },
      ],
    },
  },
  // Browser code: the admin shells and the product surfaces. Each of them owns its own copy of the
  // shadcn components, which are upstream source and are linted as they are shipped.
  {
    files: ['**/web/src/**/*.{ts,tsx}', 'modules/site/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      /*
       * Named one by one on purpose. `configs.recommended` is a flat-config array, so spreading
       * `.rules` off it spreads `undefined` and silently enables nothing — which is what happened
       * here until a lint rule was expected to catch something and did not.
       */
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      /*
       * Browser code may read the server's types and nothing else.
       *
       * With tRPC this import is not optional: a client is typed from the router, so `web` has to
       * name a type that lives in `src`. The difference between borrowing the type and shipping the
       * server is one word — `import type { AuthAdminRouter }` versus `import { authRouter }` — and
       * the second puts routers, repositories and `pg` into a browser bundle without a single error.
       * `verbatimModuleSyntax` does not catch it: it forces the keyword where a type is meant and
       * never forbids meaning a value. Hence the typescript-eslint variant — `allowTypeImports` is
       * the whole point.
       *
       * It covers the route no other check sees, a relative path up and back into `src`:
       * `check-boundaries` looks for crossings between modules, and this one stays inside one.
       */
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/src/**'],
              allowTypeImports: true,
              message:
                'Browser code may take types from the server, never values. Use `import type`, or the module door @template/<name>/contract.',
            },
          ],
        },
      ],
    },
  },
);
