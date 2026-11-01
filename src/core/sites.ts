// Site crawlers live in their own git repository, checked out at `crawlers/` and
// ignored by this one: they are the agents' output and are dropped and
// regenerated wholesale, so that churn stays out of the core's history. This
// module is the only place that knows where they live, what they may be called,
// and how they are loaded.

import { existsSync, readdirSync } from 'fs';
import { isAbsolute, resolve, sep } from 'path';
import type Crawler from './crawler';
import { Config, SiteConfig } from './models';

/** A site crawler module: its Crawler subclass, its optional entry page, and config. */
export interface SiteModule {
  default: typeof Crawler;
  /** The home page to queue when the site is populated. Optional. */
  SEED_URL?: string;
  site?: SiteConfig;
}

/** The repository root; this file is `<root>/src/core/sites.ts`. */
const ROOT = resolve(__dirname, '..', '..');
export const DEFAULT_SITES_DIR = resolve(ROOT, 'crawlers');

/** Site names become file names, database rows and shell arguments. */
const VALID_NAME = /^[a-z0-9][a-z0-9-]*$/;

type SitesConfig = Pick<Config, 'sites'>;

/** Where the crawler modules live: config, then `JSCRAWL_SITES_DIR`, then the checkout. */
export function sitesDir(config?: SitesConfig): string {
  const dir = config?.sites?.dir ?? process.env.JSCRAWL_SITES_DIR;
  if (!dir) return DEFAULT_SITES_DIR;
  return isAbsolute(dir) ? dir : resolve(ROOT, dir);
}

/** The absolute module path of a site's crawler, without loading it. */
export function siteModulePath(name: string, config?: SitesConfig): string {
  if (!VALID_NAME.test(name)) {
    throw new Error(`Invalid site name "${name}": use lower-case letters, digits and dashes`);
  }
  const dir = sitesDir(config);
  const path = resolve(dir, name);
  if (!existsSync(`${path}.ts`) && !existsSync(`${path}.js`)) {
    const hint = dir === DEFAULT_SITES_DIR ? ' - clone the crawlers repository into crawlers/' : '';
    throw new Error(`No crawler "${name}" in ${dir}${hint}`);
  }
  return path;
}

/**
 * A site's test pages: `<sites dir>/fixtures/<name>/`, versioned with its crawler.
 * Its `pages.json` lists them as `[{type, file, url}]`, `file` relative to it.
 */
export function fixtureDir(name: string, config?: SitesConfig): string {
  if (!VALID_NAME.test(name)) {
    throw new Error(`Invalid site name "${name}": use lower-case letters, digits and dashes`);
  }
  return resolve(sitesDir(config), 'fixtures', name);
}

/** Every site module name in the sites directory, sorted for stable output. */
export function siteNames(config?: SitesConfig): string[] {
  const dir = sitesDir(config);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((file) => {
      const match = /^(.+)\.(ts|js)$/.exec(file);
      return match && VALID_NAME.test(match[1]) ? [match[1]] : [];
    })
    .sort();
}

/**
 * The core's own modules stay cached when a crawler is loaded, except these: the
 * logger owns process-wide winston transports, so a second copy would open the
 * log files again, and this module is the loader itself.
 */
const KEEP_CACHED = new Set([__filename, resolve(__dirname, 'logger.ts'), resolve(__dirname, 'logger.js')]);

/**
 * Drops the cached copies of jscrawl's own core modules, so a crawler is loaded
 * against the code on disk. A long-lived process - the MCP tool server behind
 * `jscrawl_scrapePreview` - otherwise runs the core it compiled at startup, and a
 * crawler importing a helper added since then does not compile at all.
 */
function dropCoreCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(__dirname + sep) && !KEEP_CACHED.has(key)) delete require.cache[key];
  }
}

/**
 * Loads a site's crawler module. `require`, not `import()`: crawler modules are
 * CommonJS TypeScript loaded through ts-node, and callers need them synchronously.
 *
 * The cached copies are dropped first: crawlers are edited constantly (by the
 * agents, usually), and so is the core they import.
 */
export function siteModule(name: string, config?: SitesConfig): SiteModule {
  const path = siteModulePath(name, config);
  dropCoreCache();
  for (const candidate of [`${path}.ts`, `${path}.js`, path]) {
    try {
      delete require.cache[require.resolve(candidate)];
    } catch {
      // not resolvable under that extension
    }
  }
  return require(path);
}
