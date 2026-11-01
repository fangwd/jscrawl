import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Config } from '../src/core/models';
import { lintCrawler } from '../src/core/lint';
import { typecheckCrawler } from '../src/core/typecheck';
import { domainTools } from '../src/mcp/tools';

const cwd = mkdtempSync(join(tmpdir(), 'jscrawl-validation-'));
const dir = join(cwd, 'crawlers');
const config = { sites: { dir } } as Config;
const tools = domainTools({ config, db: {} as any, cwd, jscrawlUrl: 'http://127.0.0.1:1', imagedUrl: 'http://127.0.0.1:1' });
const named = (name: string) => tools.find((tool) => tool.name === name)!;

beforeAll(() => {
  mkdirSync(dir);
  writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'es2022', module: 'commonjs', types: [] },
  }));
});
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

test('validation catches the string-versus-object error before executing fixtures', async () => {
  writeFileSync(join(dir, 'shop.ts'), "export const choices = ['Small', 'Large'].map(value => value.name);\n");
  const report = JSON.parse(await named('validateCrawler').execute({
    site: 'shop', pages: [{ type: 'product', file: 'missing.html' }],
  }, { cwd }));
  expect(report).toMatchObject({ ok: false, pages: [], typecheck: { ok: false, file: 'crawlers/shop.ts' } });
  expect(report.typecheck.diagnostics).toEqual([
    expect.objectContaining({ file: 'crawlers/shop.ts', line: 1, code: 2339, message: expect.stringContaining("type 'string'") }),
  ]);
  expect(report.typecheck.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  expect(existsSync(join(cwd, 'build'))).toBe(false);
});

test('typechecking reads edits and imported helpers without including unrelated crawlers', () => {
  writeFileSync(join(dir, 'broken.ts'), 'export const unrelated: number = "wrong";');
  writeFileSync(join(dir, 'helper.ts'), 'export const values = ["Small"];');
  writeFileSync(join(dir, 'shop.ts'), 'import { values } from "./helper"; export const choices = values.map(value => value.name);');
  const before = typecheckCrawler(config, 'shop', cwd);
  expect(before.ok).toBe(false);
  expect(before.diagnostics.every((diagnostic) => diagnostic.file === 'crawlers/shop.ts')).toBe(true);
  writeFileSync(join(dir, 'helper.ts'), 'export const values = [{ name: "Small" }];');
  expect(typecheckCrawler(config, 'shop', cwd).ok).toBe(true);
  writeFileSync(join(dir, 'shop.ts'), 'export const choices = ["Small", "Large"];');
  const after = typecheckCrawler(config, 'shop', cwd);
  expect(after.ok).toBe(true);
  expect(after.sourceHash).not.toBe(before.sourceHash);
  expect(existsSync(join(dir, 'shop.js'))).toBe(false);
});

test('validation cannot mark a product fixture complete without a section contract', async () => {
  writeFileSync(join(dir, 'shop.ts'), 'export const ready = true;\n');
  const report = JSON.parse(await named('validateCrawler').execute({
    site: 'shop', pages: [{ type: 'product', file: 'product.html' }], limit: 0,
  }, { cwd }));
  expect(report).toMatchObject({ ok: false, pages: [], typecheck: { ok: true } });
  expect(report.contracts).toEqual([expect.stringContaining('product fixtures require a sections inventory')]);
});

test('the edit/finish hook rejects legacy product manifests without section contracts', async () => {
  writeFileSync(join(dir, 'shop.ts'), 'export const ready = true;\n');
  const fixtures = join(dir, 'fixtures', 'shop');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'pages.json'), JSON.stringify([{ type: 'product', file: 'product.html' }]));
  await expect(named('checkCrawler').execute({ file: 'crawlers/shop.ts' }, { cwd }))
    .rejects.toThrow(/CONTRACT .*product fixtures require a sections inventory/);
});

test('saved JSON preserves exact field types and reports missing paths', async () => {
  const file = join(cwd, 'product.json');
  writeFileSync(file, JSON.stringify({
    options: [{ name: 'Size', values: ['Small', 'Large'] }],
    variants: [{ price: 1200, compare_at_price: null }],
    images: ['https://shop.test/main.jpg'],
    empty: null, zero: 0, available: false,
  }));
  const json = named('json');
  expect(await json.execute({ file }, { cwd })).toContain('options: array[1]');
  expect(JSON.parse(await json.execute({ file, path: 'options.0.values' }, { cwd }))).toEqual(['Small', 'Large']);
  expect(JSON.parse(await json.execute({ file, path: 'variants.0' }, { cwd }))).toEqual({ price: 1200, compare_at_price: null });
  expect(JSON.parse(await json.execute({ file, path: 'images.0' }, { cwd }))).toBe('https://shop.test/main.jpg');
  for (const [path, value] of [['empty', null], ['zero', 0], ['available', false]]) {
    expect(JSON.parse(await json.execute({ file, path }, { cwd }))).toBe(value);
  }
  for (const path of ['options.0.values.0.name', 'missing', '__proto__']) {
    await expect(json.execute({ file, path }, { cwd })).rejects.toThrow(/No JSON value/);
  }
});

test('the rule check names each banned pattern by line, and skips comments', () => {
  const source = [
    'const MAX_PAGES = 20;',
    '// const MAX_PAGES = 20; a comment does not count',
    'const PAGE_SIZE = 250;',
    'await this.db.flush();',
    "const CATEGORY_SLUGS = new Set(['tiles']);",
    "writeFileSync('/tmp/dry.json', body);",
    "const response = await this.client.get(url, { method: 'POST' });",
    'void this.scrapeProduct(doc);',
    'await this.scrapeCategory(doc);',
    'return this.scrapeProduct(doc);',
    'async scrapeProduct(doc: XDocument) {',
  ].join('\n');
  expect(lintCrawler(source).map(({ line, rule }) => [line, rule])).toEqual([
    [1, 'page-cap'],
    [4, 'flush'],
    [5, 'slug-list'],
    [6, 'tmp-path'],
    [7, 'raw-client'],
    [8, 'unawaited-scrape'],
  ]);
});
