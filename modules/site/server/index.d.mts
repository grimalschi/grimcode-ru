/**
 * Types for the Node entry of the site.
 *
 * `index.mjs` is handwritten JavaScript — tsc never compiles it, so nothing else would describe
 * it. The extension has to be `.d.mts`: this workspace resolves modules as NodeNext, which picks
 * declarations by the file extension, and a `.d.ts` next to an `.mjs` is not found at all
 * (`TS7016: Could not find a declaration file`).
 *
 * This is also why `site` can never be a project reference: its tsconfig is `noEmit` with bundler
 * resolution, for the framework's own build. The composer reaches it as an ordinary dependency,
 * through the `./server` export, and the build order comes from that declared dependency.
 */
import type { Hono } from 'hono';

export interface SiteOptions {
  /** The site's public address. Every generated link — robots, sitemap — is built from it. */
  origin: string;
}

/** Builds the site application. It listens to nothing; the composer owns the port. */
export declare function createApp(options: SiteOptions): Hono;
