import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { submissionFiles, submitCrawler, syncCrawlers } from '../src/core/crawlersRepo';

let root: string;
let remote: string;
let work: string;
let gh: string;
let ghLog: string;

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const write = (dir: string, file: string, text: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
};
const identity = (dir: string) => {
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
};
/** A clone of the remote, as another machine or the merge on GitHub would have. */
function clone(name: string): string {
  const dir = join(root, name);
  git(root, 'clone', '--quiet', remote, dir);
  identity(dir);
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jscrawl-repo-'));
  remote = join(root, 'origin.git');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  const seed = join(root, 'seed');
  git(root, 'init', '--quiet', '--initial-branch=main', seed);
  identity(seed);
  write(seed, 'other.ts', 'export {};\n');
  write(seed, 'fixtures/shop/old.html', 'an earlier test page');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'start');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '--quiet', 'origin', 'main');
  work = clone('work');

  // gh: `pr list` answers from a file the test controls, `pr create` returns a url; every call is logged
  ghLog = join(root, 'gh.log');
  gh = join(root, 'gh');
  writeFileSync(
    gh,
    `#!/bin/sh\necho "$@" >> ${ghLog}\nif [ "$2" = list ]; then cat ${join(root, 'open-pr')} 2>/dev/null || true; else echo https://github.test/pr/1; fi\n`
  );
  chmodSync(gh, 0o755);

  // the agent's work: a crawler and its test pages, one with recorded fetches, plus scratch
  write(work, 'shop.ts', 'export const SEED_URL = "https://shop.test/";\n');
  write(work, 'fixtures/shop/pages.json', JSON.stringify([
    { type: 'seed', file: 'home.html', url: 'https://shop.test/' },
    { type: 'product', file: 'product-1.html', url: 'https://shop.test/p1', sections: [
      { name: 'Name', selector: 'body', status: 'extracted', evidence: 'p1',
        expect: [{ table: 'product', field: 'name', contains: ['p1'] }] },
    ] },
  ]));
  write(work, 'fixtures/shop/home.html', '<html>home</html>');
  write(work, 'fixtures/shop/product-1.html', '<html>p1</html>');
  write(work, 'fixtures/shop/product-1.html.fetches/abc', '{"price": 1}');
  write(work, 'fixtures/shop/scratch.json', 'explored, not a test page');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test('a submission is the crawler, its pages.json, the listed pages and their recorded fetches', async () => {
  expect((await submissionFiles(work, 'shop')).sort()).toEqual([
    'fixtures/shop/home.html',
    'fixtures/shop/pages.json',
    'fixtures/shop/product-1.html',
    'fixtures/shop/product-1.html.fetches/abc',
    'shop.ts',
  ]);
  write(work, 'fixtures/shop/pages.json', JSON.stringify([{ type: 'product', file: '../../shop.ts' }]));
  await expect(submissionFiles(work, 'shop')).rejects.toThrow(/outside fixtures\/shop/);
  rmSync(join(work, 'fixtures/shop/pages.json'));
  await expect(submissionFiles(work, 'shop')).rejects.toThrow(/must list the site's test pages/);
});

test('submitting pushes a branch off main and opens a pull request, leaving the checkout alone', async () => {
  const head = git(work, 'rev-parse', 'HEAD');
  const result = await submitCrawler(work, 'shop', 'shop: new crawler\n\nReads the listing API.', { gh });

  expect(result).toMatchObject({ branch: 'crawler/shop', pr: 'https://github.test/pr/1' });
  // the checkout: same commit, same branch, the work still uncommitted
  expect(git(work, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  expect(git(work, 'status', '--porcelain')).toContain('?? shop.ts');

  const branch = clone('review');
  git(branch, 'checkout', '--quiet', 'crawler/shop');
  expect(git(branch, 'log', '--format=%s', '-1')).toBe('shop: new crawler');
  expect(git(branch, 'rev-parse', 'HEAD~1')).toBe(head);
  // the listed pages replace the site's earlier ones; scratch stays out; other sites are untouched
  expect(git(branch, 'ls-files').split('\n').sort()).toEqual([
    'fixtures/shop/home.html',
    'fixtures/shop/pages.json',
    'fixtures/shop/product-1.html',
    'fixtures/shop/product-1.html.fetches/abc',
    'other.ts',
    'shop.ts',
  ]);
  const create = readFileSync(ghLog, 'utf8').split('\n').find((line) => line.startsWith('pr create'))!;
  expect(create).toContain('--head crawler/shop --base main --title shop: new crawler --body Reads the listing API.');

  // a resubmission updates the open pull request rather than opening another
  writeFileSync(join(root, 'open-pr'), 'https://github.test/pr/1\n');
  write(work, 'shop.ts', 'export const SEED_URL = "https://shop.test/au";\n');
  await submitCrawler(work, 'shop', 'shop: seed the AU store', { gh });
  expect(readFileSync(ghLog, 'utf8').match(/pr create/g)).toHaveLength(1);
  git(branch, 'fetch', '--quiet', 'origin');
  expect(git(branch, 'show', 'origin/crawler/shop:shop.ts')).toContain('/au');
});

test('a submission identical to main is refused', async () => {
  const merged = clone('merged');
  for (const file of await submissionFiles(work, 'shop')) write(merged, file, readFileSync(join(work, file), 'utf8'));
  git(merged, 'rm', '--quiet', 'fixtures/shop/old.html');
  git(merged, 'add', '.');
  git(merged, 'commit', '--quiet', '-m', 'merged');
  git(merged, 'push', '--quiet', 'origin', 'main');
  await expect(submitCrawler(work, 'shop', 'shop: again', { gh })).rejects.toThrow(/Nothing to submit/);
});

describe('syncCrawlers', () => {
  /** Lands the work's submission on main, as merging its pull request does. */
  async function merge() {
    const { branch } = await submitCrawler(work, 'shop', 'shop: new crawler', { gh });
    const merged = clone('merge');
    git(merged, 'merge', '--quiet', '--ff-only', `origin/${branch}`);
    git(merged, 'push', '--quiet', 'origin', 'main');
  }

  test('fast-forwards to main, making way for local copies of what was merged', async () => {
    await merge();
    const result = await syncCrawlers(work);
    expect(result).toMatchObject({ synced: true });
    expect(git(work, 'rev-parse', 'HEAD')).toBe(git(work, 'rev-parse', 'origin/main'));
    // scratch the submission left out is still there; the merged files are now tracked
    expect(git(work, 'status', '--porcelain')).toBe('?? fixtures/shop/scratch.json');
    expect(await syncCrawlers(work)).toEqual({ synced: false, reason: 'up to date' });
  });

  test('keeps a local edit that differs from what main brings', async () => {
    await merge();
    write(work, 'shop.ts', 'export const SEED_URL = "https://shop.test/still-editing";\n');
    expect(await syncCrawlers(work)).toEqual({ synced: false, reason: 'shop.ts has local changes that differ from main' });
    expect(readFileSync(join(work, 'shop.ts'), 'utf8')).toContain('still-editing');
  });

  test('a checkout without a remote is left alone', async () => {
    git(work, 'remote', 'remove', 'origin');
    expect(await syncCrawlers(work)).toEqual({ synced: false, reason: 'no origin remote' });
    expect(existsSync(join(work, 'shop.ts'))).toBe(true);
  });
});
