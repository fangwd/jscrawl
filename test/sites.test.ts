// The crawler-module seam: where site modules live, and what may be asked for.
// Site names come from the CLI, the database and the agents, and they end up in
// a require path.

import { execFile } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { promisify } from 'util';
import { DEFAULT_SITES_DIR, siteModule, siteModulePath, siteNames, sitesDir } from '../src/core/sites';

const FIXTURES = 'test/fixtures/site-modules';

beforeAll(() => {
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(
    `${FIXTURES}/shop.ts`,
    "export const SEED_URL = 'https://shop.test/';\nexport const site = {};\nexport default class Shop {}\n"
  );
  writeFileSync(`${FIXTURES}/README.md`, 'not a site module\n');
});
afterAll(() => rmSync(FIXTURES, { recursive: true, force: true }));

test('the directory comes from config, then the environment, then the checkout', () => {
  expect(sitesDir()).toBe(DEFAULT_SITES_DIR);
  expect(DEFAULT_SITES_DIR.endsWith('/crawlers')).toBe(true);
  process.env.JSCRAWL_SITES_DIR = FIXTURES;
  try {
    // A relative directory resolves against the repository root.
    expect(sitesDir()).toBe(`${process.cwd()}/${FIXTURES}`);
    expect(sitesDir({ sites: { dir: 'elsewhere' } })).toMatch(/\/elsewhere$/);
    expect(sitesDir({ sites: { dir: '/opt/absolute' } })).toBe('/opt/absolute');
  } finally {
    delete process.env.JSCRAWL_SITES_DIR;
  }
});

test('a name resolves to a module and loads it', () => {
  process.env.JSCRAWL_SITES_DIR = FIXTURES;
  try {
    expect(siteModulePath('shop')).toBe(`${process.cwd()}/${FIXTURES}/shop`);
    const loaded = siteModule('shop');
    expect(loaded.SEED_URL).toBe('https://shop.test/');
    expect(loaded.site).toEqual({});
    expect(typeof loaded.default).toBe('function');
    expect(siteNames()).toEqual(['shop']);
  } finally {
    delete process.env.JSCRAWL_SITES_DIR;
  }
});

test('names that are not plain file names are refused', () => {
  for (const name of ['../etc/passwd', 'a/b', 'Shop', 'a_b', '', '.hidden', 'shop.ts']) {
    expect(() => siteModulePath(name, { sites: { dir: FIXTURES } })).toThrow(/Invalid site name/);
  }
});

test('an edited crawler is reloaded rather than served from the require cache', async () => {
  // Jest has its own module registry, so this runs in a real ts-node process -
  // the runtime the MCP tool server (jscrawl_scrapePreview) uses.
  const module = `${FIXTURES}/edited.ts`;
  const first = "export const SEED_URL = 'first';\nexport default class C {}\n";
  const second = "export const SEED_URL = 'second';\nexport default class C {}\n";
  writeFileSync(module, first);
  const script = [
    `const { siteModule } = require(${JSON.stringify(`${process.cwd()}/src/core/sites`)});`,
    `const { writeFileSync } = require('fs');`,
    `const config = { sites: { dir: ${JSON.stringify(FIXTURES)} } };`,
    `const before = siteModule('edited', config).SEED_URL;`,
    `writeFileSync(${JSON.stringify(module)}, ${JSON.stringify(second)});`,
    `const after = siteModule('edited', config).SEED_URL;`,
    `console.log(JSON.stringify({ before, after }));`,
  ].join('\n');
  try {
    const { stdout } = await promisify(execFile)('node', ['-r', 'ts-node/register', '-e', script], {
      cwd: process.cwd(),
      timeout: 90_000,
    });
    expect(JSON.parse(stdout.trim())).toEqual({ before: 'first', after: 'second' });
  } finally {
    rmSync(module);
  }
}, 120_000);

test('a crawler is loaded against the core on disk, and the logger is left alone', async () => {
  // The MCP tool server is long-lived: without dropping the core's cached copies,
  // a crawler that imports a helper added to src/core since the server started
  // fails to compile at all (TS2305), and one that calls a changed helper runs the
  // old behaviour. The logger owns process-wide transports, so it must survive.
  const core = (name: string) => `${process.cwd()}/src/core/${name}`;
  const script = [
    `const { siteModule } = require(${JSON.stringify(core('sites'))});`,
    `const extractBefore = require(${JSON.stringify(core('extract'))});`,
    `const loggerBefore = require(${JSON.stringify(core('logger'))});`,
    `siteModule('shop', { sites: { dir: ${JSON.stringify(FIXTURES)} } });`,
    `const extractAfter = require(${JSON.stringify(core('extract'))});`,
    `const loggerAfter = require(${JSON.stringify(core('logger'))});`,
    `console.log(JSON.stringify({`,
    `  freshExtract: extractBefore !== extractAfter,`,
    `  sameLogger: loggerBefore === loggerAfter,`,
    `  stillExports: typeof extractAfter.visibleText === 'function'`,
    `}));`,
  ].join('\n');
  const { stdout } = await promisify(execFile)('node', ['-r', 'ts-node/register', '-e', script], {
    cwd: process.cwd(),
    timeout: 90_000,
  });
  expect(JSON.parse(stdout.trim())).toEqual({ freshExtract: true, sameLogger: true, stillExports: true });
}, 120_000);

test('a missing crawler says where to look', () => {
  expect(() => siteModulePath('nope', { sites: { dir: FIXTURES } })).toThrow(
    `No crawler "nope" in ${process.cwd()}/${FIXTURES}`
  );
  // The default directory is a checkout of another repository, so say so.
  expect(() => siteModulePath('nope')).toThrow(/clone the crawlers repository into crawlers\//);
});
