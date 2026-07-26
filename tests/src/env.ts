/**
 * Reads the repository's `.env` for the acceptance run.
 *
 * The suite needs the port the stack is actually on and the owner it may work as, and both already
 * live in `.env`. Reading them here means the suite runs with a plain `pnpm test` rather than
 * asking anyone to export variables by hand — and the file is parsed, not sourced by a shell, so a
 * password containing spaces survives.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const envPath = join(repoRoot, '.env');

export default function setup(): void {
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1] ?? '';
    // A value a human quoted by hand is unwrapped; anything else is taken literally, spaces
    // included.
    const value = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');

    // A variable already in the environment wins, so a one-off run can still override the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }

  if (!process.env.ACCEPTANCE_BASE_URL && process.env.GATEWAY_PORT) {
    process.env.ACCEPTANCE_BASE_URL = `http://127.0.0.1:${process.env.GATEWAY_PORT}`;
  }
}
