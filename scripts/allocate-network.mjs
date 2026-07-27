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
 *
 * It also knows how to recognise what this template left behind. Worktrees are created and thrown
 * away often, and a deleted checkout leaves its network and its volume on the machine: the network
 * keeps holding address space nothing will ever use again, which is what exhausts the pools in the
 * first place.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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

/**
 * Whether this copy already has a pinned subnet.
 *
 * An existing override is never re-evaluated automatically: the running stack is on that subnet,
 * and quietly moving it to another one recreates the network under the containers, which then
 * cannot resolve each other. Re-evaluating is what running this script directly is for.
 */
export function hasOverride() {
  return existsSync(OVERRIDE_PATH);
}

export function readOverride() {
  if (!existsSync(OVERRIDE_PATH)) return null;
  return /subnet:\s*(\S+)/.exec(readFileSync(OVERRIDE_PATH, 'utf8'))?.[1] ?? null;
}

export function clearOverride() {
  if (existsSync(OVERRIDE_PATH)) unlinkSync(OVERRIDE_PATH);
}

/**
 * Compose networks of this template that no checkout claims any more.
 *
 * Recognised narrowly on purpose: the Compose project label, this template's own `<slug>_internal`
 * name, no container attached, and a project slug that no live checkout uses. A stopped stack of a
 * checkout that still exists is never touched — its slug is live, and it is about to be started
 * again.
 */
export function staleProjectNetworks(liveSlugs) {
  let names;
  try {
    names = docker([
      'network',
      'ls',
      '--filter',
      'label=com.docker.compose.project',
      '--format',
      '{{.Name}}',
    ])
      .split('\n')
      .filter(Boolean);
  } catch {
    // No Docker, or no networks to look at: nothing to clean either way.
    return [];
  }
  if (names.length === 0) return [];

  const stale = [];
  for (const name of names) {
    let line;
    try {
      line = docker([
        'network',
        'inspect',
        name,
        '--format',
        '{{index .Labels "com.docker.compose.project"}}|{{len .Containers}}|{{range .IPAM.Config}}{{.Subnet}} {{end}}',
      ]);
    } catch {
      continue;
    }

    const [project, attached, subnets] = line.split('|');
    if (!project || liveSlugs.has(project)) continue;
    if (name !== `${project}_internal`) continue;
    if (Number(attached) !== 0) continue;

    stale.push({ name, subnet: subnets.trim() });
  }
  return stale;
}

/** Removes them, returning what actually went. A network in use is left alone by Docker itself. */
export function removeStaleProjectNetworks(liveSlugs) {
  const removed = [];
  for (const network of staleProjectNetworks(liveSlugs)) {
    try {
      docker(['network', 'rm', network.name]);
      removed.push(network);
    } catch {
      // Something attached itself in the meantime. Not our business to force.
    }
  }
  return removed;
}

/**
 * Volumes of checkouts that no longer exist.
 *
 * Reported, never removed: a volume is the database of a branch someone may still want back, and
 * this script has no way of knowing. The command to remove them is printed instead.
 */
export function orphanedProjectVolumes(liveSlugs) {
  let names;
  try {
    names = docker([
      'volume',
      'ls',
      '--filter',
      'label=com.docker.compose.project',
      '--format',
      '{{.Name}}',
    ])
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }

  return names.filter((name) => {
    try {
      const project = docker([
        'volume',
        'inspect',
        name,
        '--format',
        '{{index .Labels "com.docker.compose.project"}}',
      ]);
      return project !== '' && !liveSlugs.has(project) && name === `${project}_postgres-data`;
    } catch {
      return false;
    }
  });
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
