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
              group: ['**/services/*'],
              message:
                'Services must not import each other. Use contracts/ and HTTP/oRPC instead.',
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
  // Browser code: the admin shells and the product surfaces. Each of them owns its own copy of the
  // shadcn components, which are upstream source and are linted as they are shipped.
  {
    files: ['**/web/src/**/*.{ts,tsx}', 'services/site/app/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The components are vendored verbatim from the shadcn registry, so their exports are not
      // rewritten to satisfy a lint rule the upstream project does not apply.
      'react-refresh/only-export-components': 'off',
    },
  },
);
