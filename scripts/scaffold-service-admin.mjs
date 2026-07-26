#!/usr/bin/env node
/**
 * Sets up the build for one service admin.
 *
 * Every service owns its admin outright: its own `components.json`, its own copy of the shadcn
 * components it uses, and its own design tokens. Nothing here is shared at runtime, so one service
 * can restyle or replace its admin without touching another's. This script only creates that
 * starting point — the screens themselves are written per service.
 *
 * Usage: node scripts/scaffold-service-admin.mjs <service> <component...>
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [service, ...components] = process.argv.slice(2);

if (!service) {
  console.error('Usage: node scripts/scaffold-service-admin.mjs <service> <component...>');
  process.exit(1);
}

const source = join(repoRoot, 'services/admin/web/src');
const target = join(repoRoot, `services/${service}/web/src`);

for (const directory of ['components/ui', 'components/layout', 'hooks', 'lib', 'frame', 'routes']) {
  mkdirSync(join(target, directory), { recursive: true });
}

// The pieces every admin needs, copied rather than imported.
const FILES = [
  'lib/utils.ts',
  'hooks/use-mobile.ts',
  'hooks/use-applied-theme.ts',
  'hooks/use-async.ts',
  'components/theme-provider.tsx',
  'components/theme-toggle.tsx',
  'components/layout/admin-page.tsx',
  'components/layout/data-table.tsx',
  'styles.css',
];

for (const file of FILES) cpSync(join(source, file), join(target, file));
for (const name of components) {
  cpSync(join(source, `components/ui/${name}.tsx`), join(target, `components/ui/${name}.tsx`));
}

// The shell drives the frame; a service admin answers it.
cpSync(
  join(repoRoot, 'services/admin/web/src/frame'),
  join(target, 'frame'),
  { recursive: true },
);

const componentsJson = readFileSync(join(repoRoot, 'services/admin/web/components.json'), 'utf8');
writeFileSync(join(repoRoot, `services/${service}/web/components.json`), componentsJson);

const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${service} admin</title>
    <script>
      // Applied before the first paint. Embedded in the shell, the theme arrives by message a
      // moment later; standing alone, this is the only source.
      (() => {
        try {
          const stored = localStorage.getItem('template.${service}.theme') ?? 'system';
          const dark =
            stored === 'dark' ||
            (stored === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
          document.documentElement.dataset.theme = dark ? 'dark' : 'light';
          document.documentElement.classList.toggle('dark', dark);
          document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
        } catch {
          /* A browser without storage still gets the light theme. */
        }
      })();
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
writeFileSync(join(repoRoot, `services/${service}/web/index.html`), indexHtml);

const viteConfig = `import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The ${service} service admin.
 *
 * Served by this service under its protected path, so the base must match: assets have to resolve
 * both inside the Admin shell's iframe and when the protected URL is opened directly.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/admin/service/${service}/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
`;
writeFileSync(join(repoRoot, `services/${service}/web/vite.config.ts`), viteConfig);

cpSync(
  join(repoRoot, 'services/admin/web/tsconfig.json'),
  join(repoRoot, `services/${service}/web/tsconfig.json`),
);

// Build-time only: `pnpm deploy --prod` keeps these out of the runtime image, which needs the
// built assets and nothing else.
const UI_DEPENDENCIES = {
  '@orpc/contract': '1.14.10',
  '@tailwindcss/vite': '4.3.3',
  '@tanstack/react-router': '1.170.18',
  '@types/react': '19.2.17',
  '@types/react-dom': '19.2.3',
  '@vitejs/plugin-react': '6.0.4',
  'class-variance-authority': '0.7.1',
  clsx: '2.1.1',
  'lucide-react': '1.26.0',
  'radix-ui': '1.6.7',
  react: '19.2.8',
  'react-dom': '19.2.8',
  sonner: '2.0.7',
  'tailwind-merge': '3.6.0',
  tailwindcss: '4.3.3',
  'tw-animate-css': '1.4.0',
  vite: '8.1.5',
};

const manifestPath = join(repoRoot, `services/${service}/package.json`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

manifest.files = [...new Set([...(manifest.files ?? ['dist']), 'web/dist'])];
manifest.scripts.build = 'tsc -b tsconfig.json && vite build --config web/vite.config.ts';
manifest.scripts.typecheck = 'tsc -b tsconfig.json && tsc -p web/tsconfig.json';
manifest.scripts.lint = 'eslint src web/src';
manifest.scripts['dev:web'] = 'vite --config web/vite.config.ts';
manifest.devDependencies = Object.fromEntries(
  Object.entries({ ...manifest.devDependencies, ...UI_DEPENDENCIES }).sort(([a], [b]) =>
    a.localeCompare(b),
  ),
);

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

if (!existsSync(join(repoRoot, `services/${service}/web/src/main.tsx`))) {
  console.log(`Scaffolded services/${service}/web — now write its screens.`);
}

execFileSync('pnpm', ['install'], { cwd: repoRoot, stdio: 'inherit' });
