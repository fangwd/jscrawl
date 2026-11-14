import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';

import { crawlerSources } from '../src/core/crawler-sources';
import { submissionFiles } from '../src/core/crawlersRepo';
import { typecheckCrawler } from '../src/core/typecheck';

let root: string;
const write = (file: string, text: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crawler-shared-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('a site includes only its transitive shared imports, including re-exports and cycles', async () => {
  write('shop.ts', "import { value } from './lib/platform'; export default value;\n");
  write('lib/platform/index.ts', "export { value } from '../value';\n");
  write('lib/value.ts', "import './platform'; export const value = 1;\n");
  write('lib/unrelated.ts', 'export const value = 2;');
  write(
    'fixtures/shop/pages.json',
    JSON.stringify([{ type: 'page', file: 'page.html', url: 'https://shop.test/p' }]),
  );
  write('fixtures/shop/page.html', 'hello');
  expect(crawlerSources(join(root, 'shop.ts')).map((file) => relative(root, file))).toEqual([
    'lib/platform/index.ts',
    'lib/value.ts',
    'shop.ts',
  ]);
  expect((await submissionFiles(root, 'shop')).sort()).toEqual([
    'fixtures/shop/page.html',
    'fixtures/shop/pages.json',
    'lib/platform/index.ts',
    'lib/value.ts',
    'shop.ts',
  ]);
});

test('editing a shared dependency invalidates a successful source fingerprint and checks its types', () => {
  write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        types: [],
        strict: true,
        skipLibCheck: true,
        target: 'es2020',
        module: 'commonjs',
      },
    }),
  );
  write(
    'shop.ts',
    "import { value } from './lib/value'; const n: number = value; export default n;\n",
  );
  write('lib/value.ts', 'export const value = 1;\n');
  const config = { sites: { dir: root } } as any;
  const before = typecheckCrawler(config, 'shop', root);
  expect(before.ok).toBe(true);
  write('lib/value.ts', "export const value = 'changed';\n");
  const after = typecheckCrawler(config, 'shop', root);
  expect(after.ok).toBe(false);
  expect(after.sourceHash).not.toBe(before.sourceHash);
});

test('a missing shared module cannot silently be omitted from a submission', () => {
  write('shop.ts', "export { default } from './lib/missing';\n");
  expect(() => crawlerSources(join(root, 'shop.ts'))).toThrow(/Missing shared crawler module/);
});
