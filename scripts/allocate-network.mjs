#!/usr/bin/env node
/**
 * Allocates a project-specific Docker subnet when Docker's default address pools are exhausted.
 *
 * The template does not pin one shared subnet: normally Docker picks the network itself, and
 * several copies or worktrees coexist without any configuration. Only when the pools really run
 * out does this write a local, git-ignored Compose override with a free subnet.
 *
 * It never deletes or reconfigures anyone else's Docker network — it only reads which subnets are
 * taken and picks one that is not.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const OVERRIDE_PATH = join(repoRoot, 'docker/compose.network.local.yaml');

function docker(args, options = {}) {
  return execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    .toString()
    .trim();
}

/** Every subnet Docker currently has assigned, including other projects'. */
function takenSubnets() {
  const ids = docker(['network', 'ls', '-q']).split('\n').filter(Boolean);
  if (ids.length === 0) return new Set();

  const output = docker([
    'network',
    'inspect',
    ...ids,
    '--format',
    '{{range .IPAM.Config}}{{.Subnet}} {{end}}',
  ]);

  return new Set(output.split(/\s+/).filter(Boolean));
}

/**
 * Picks a free `/24` inside 10.0.0.0/8, far from the ranges Docker hands out by default so a
 * later automatic allocation does not collide with it.
 */
export function findFreeSubnet() {
  const taken = takenSubnets();
  for (let second = 250; second < 256; second += 1) {
    for (let third = 0; third < 256; third += 1) {
      const subnet = `10.${second}.${third}.0/24`;
      if (!taken.has(subnet)) return subnet;
    }
  }
  throw new Error('No free /24 subnet found in 10.250.0.0/14');
}

/** True when Docker can still allocate a network on its own. */
export function defaultPoolsAvailable(probeName) {
  try {
    docker(['network', 'create', '--driver', 'bridge', probeName]);
    docker(['network', 'rm', probeName]);
    return true;
  } catch {
    // Only the probe network we created ourselves is ever removed.
    try {
      docker(['network', 'rm', probeName]);
    } catch {
      /* the probe was never created */
    }
    return false;
  }
}

export function writeOverride(subnet) {
  writeFileSync(
    OVERRIDE_PATH,
    `# Generated locally because Docker's default address pools were exhausted.\n` +
      `# Git-ignored: it describes this machine, not the project.\n` +
      `networks:\n  internal:\n    ipam:\n      config:\n        - subnet: ${subnet}\n`,
  );
}

export function clearOverride() {
  if (existsSync(OVERRIDE_PATH)) unlinkSync(OVERRIDE_PATH);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const probe = `template-network-probe-${process.pid}`;

  if (defaultPoolsAvailable(probe)) {
    clearOverride();
    console.log('Docker can allocate a network by itself; no override needed.');
  } else {
    const subnet = findFreeSubnet();
    writeOverride(subnet);
    console.log(`Docker address pools are exhausted. Using ${subnet} for this copy.`);
    console.log(`Wrote ${OVERRIDE_PATH}`);
  }
}
