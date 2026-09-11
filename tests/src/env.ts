/** Loads root `.env` for the HTTP and browser suites, preserving process overrides. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const envPath = join(repoRoot, '.env');

export default function setup(): void {
  for (const [key, value] of Object.entries(existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {})) {
    // A variable already in the environment wins, so a one-off run can still override the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }

  if (!process.env.ACCEPTANCE_BASE_URL && process.env.PORT) {
    process.env.ACCEPTANCE_BASE_URL = `http://127.0.0.1:${process.env.PORT}`;
  }
}
