import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Config } from '../src/core/models';
import { registerSite, sameSite } from '../src/core/register';

test('two seed urls are one site when one path holds the other on the same host, www aside', () => {
  expect(sameSite('https://www.example.com/', 'https://example.com/')).toBe(true);
  expect(sameSite('https://example.com/', 'https://example.com/tiles/floor')).toBe(true);
  expect(sameSite('https://example.com/au/', 'https://EXAMPLE.com/au')).toBe(true);
  expect(sameSite('https://example.com/au', 'https://example.com/au/tiles?page=2')).toBe(true);
  // storefronts on their own paths or hosts are separate sites
  expect(sameSite('https://example.com/au/', 'https://example.com/nz/')).toBe(false);
  expect(sameSite('https://example.com/au', 'https://example.com/austria')).toBe(false);
  expect(sameSite('https://example.com/', 'https://nz.example.com/')).toBe(false);
  expect(sameSite('https://example.com/', 'https://example.com.au/')).toBe(false);
  expect(sameSite('not a url', 'https://example.com/')).toBe(false);
});

test('a crawler whose seed another registered site covers is refused, before anything is written', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jscrawl-register-'));
  try {
    mkdirSync(join(root, 'crawlers'));
    const module = (name: string, seed: string) =>
      writeFileSync(
        join(root, 'crawlers', `${name}.ts`),
        `export const SEED_URL = '${seed}';\nexport default class {}\n`,
      );
    module('tiles-copy', 'https://example.com/au/tiles/');
    const config = {
      sites: { dir: join(root, 'crawlers') },
    } as unknown as Config;
    const seeds = [{ name: 'example-au', url: 'https://www.example.com/au/' }];
    const db = {
      query: jest.fn(async (_sql: string, name: string) =>
        seeds.filter((seed) => seed.name !== name),
      ),
    };

    await expect(registerSite(db as any, config, 'tiles-copy')).rejects.toThrow(
      'crawlers/tiles-copy.ts: its SEED_URL https://example.com/au/tiles/ is already crawled by crawlers/example-au.ts ' +
        '(seed https://www.example.com/au/); extend that crawler instead of adding a second one',
    );
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("u.type = 'seed'"), 'tiles-copy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requestTimeout is a whole number of seconds above 0', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jscrawl-register-'));
  try {
    mkdirSync(join(root, 'crawlers'));
    writeFileSync(
      join(root, 'crawlers', 'slow.ts'),
      'export const site = { requestTimeout: 0.5 };\nexport default class {}\n',
    );
    const config = {
      sites: { dir: join(root, 'crawlers') },
    } as unknown as Config;
    await expect(registerSite({ query: jest.fn() } as any, config, 'slow')).rejects.toThrow(
      'crawlers/slow.ts: requestTimeout must be a whole number of seconds above 0',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a module's threadCount seeds a new site row and never overwrites it", async () => {
  const root = mkdtempSync(join(tmpdir(), 'jscrawl-register-'));
  try {
    mkdirSync(join(root, 'crawlers'));
    writeFileSync(
      join(root, 'crawlers', 'busy.ts'),
      'export const site = { threadCount: 3 };\nexport default class {}\n',
    );
    writeFileSync(
      join(root, 'crawlers', 'zero.ts'),
      'export const site = { threadCount: 0 };\nexport default class {}\n',
    );
    const config = {
      sites: { dir: join(root, 'crawlers') },
    } as unknown as Config;
    const upserts: { [table: string]: jest.Mock } = {};
    const db = {
      table: (name: string) => ({
        upsert: (upserts[name] ??= jest.fn(async () => ({ id: 1 }))),
      }),
    };

    await registerSite(db as any, config, 'busy');
    const [[crawlerInsert, crawlerUpdate]] = upserts.crawler.mock.calls as any[];
    expect(crawlerInsert).not.toHaveProperty('threadCount');
    expect(crawlerUpdate).not.toHaveProperty('threadCount');
    const [[siteInsert, siteUpdate]] = upserts.site.mock.calls as any[];
    expect(siteInsert).toMatchObject({ name: 'busy', threadCount: 3 });
    expect(siteUpdate).not.toHaveProperty('threadCount');

    await expect(registerSite(db as any, config, 'zero')).rejects.toThrow(
      'crawlers/zero.ts: threadCount must be a whole number above 0',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
