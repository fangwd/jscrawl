// The crawlers repository as the agents' output: a finished crawler is submitted
// for review as a pull request, and what is merged reaches the crawls through a
// fast-forward of the checkout. Both leave alone whatever else is being edited in
// the checkout - other sessions work on other sites in the same directory.

import { execFile } from 'child_process';
import { readFile, readdir, rm } from 'fs/promises';
import { join, relative, resolve, sep } from 'path';
import { promisify } from 'util';
import { z } from 'zod';
import { FixturePages } from './completeness';

const run = promisify(execFile);
const REMOTE = 'origin';
const BASE = 'main';

/** The test pages a site records for its checks, in `fixtures/<site>/pages.json`. */
export { FixturePages } from './completeness';

async function git(dir: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await run('git', args, { cwd: dir, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** Every file under `path`, relative to `root`. */
async function filesUnder(root: string, path: string): Promise<string[]> {
  const entries = await readdir(resolve(root, path), { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries.map((entry) => (entry.isDirectory() ? filesUnder(root, join(path, entry.name)) : [join(path, entry.name)]))
  );
  return files.flat();
}

/** The crawler, its pages.json, the pages it lists and what their handlers fetched: what a submission versions. */
export async function submissionFiles(dir: string, site: string): Promise<string[]> {
  const fixtures = join('fixtures', site);
  const listing = join(fixtures, 'pages.json');
  let pages: z.infer<typeof FixturePages>;
  try {
    pages = FixturePages.parse(JSON.parse(await readFile(resolve(dir, listing), 'utf8')));
  } catch (err: any) {
    throw new Error(`${listing} must list the site's test pages before it is submitted: ${String(err.message ?? err).slice(0, 300)}`);
  }
  const files = [`${site}.ts`, listing];
  for (const page of pages) {
    const file = relative(dir, resolve(dir, fixtures, page.file));
    if (!file.startsWith(fixtures + sep)) throw new Error(`${listing}: ${page.file} is outside ${fixtures}/`);
    files.push(file, ...(await filesUnder(dir, `${file}.fetches`)));
  }
  return [...new Set(files)];
}

export interface Submission {
  branch: string;
  commit: string;
  files: string[];
  pr: string;
}

/**
 * Commits a site's crawler and test pages onto `crawler/<site>`, branched from
 * the remote's main, pushes it and opens (or updates) its pull request. The
 * commit is built in a scratch index, so the checkout - and whatever else is
 * being edited in it - is never touched. Resubmitting replaces the branch with
 * one commit on the current main.
 */
export async function submitCrawler(
  dir: string,
  site: string,
  message: string,
  options: { gh?: string } = {}
): Promise<Submission> {
  const files = await submissionFiles(dir, site);
  const branch = `crawler/${site}`;
  await git(dir, ['fetch', '--quiet', REMOTE, BASE]);
  const base = await git(dir, ['rev-parse', `${REMOTE}/${BASE}`]);

  const index = join(dir, '.git', `jscrawl-submit-${site}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(dir, ['read-tree', base], env);
    // the site's fixtures are exactly the listed ones: earlier test pages no longer listed go
    const fixtures = `fixtures/${site}/`;
    for (const stale of (await git(dir, ['ls-files', '--', fixtures], env)).split('\n').filter(Boolean)) {
      if (!files.includes(stale)) await git(dir, ['update-index', '--force-remove', '--', stale], env);
    }
    for (const file of files) {
      const blob = await git(dir, ['hash-object', '-w', '--', file]);
      await git(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], env);
    }
    const tree = await git(dir, ['write-tree'], env);
    if (tree === (await git(dir, ['rev-parse', `${base}^{tree}`]))) {
      throw new Error(`Nothing to submit: ${site}'s crawler and test pages are already on ${BASE}`);
    }
    const identity = (await git(dir, ['config', 'user.name']).catch(() => '')) ? [] : ['-c', 'user.name=jscrawl agent', '-c', 'user.email=jscrawl-agent@localhost'];
    const commit = await git(dir, [...identity, 'commit-tree', tree, '-p', base, '-m', message]);
    await git(dir, ['push', '--quiet', '--force', REMOTE, `${commit}:refs/heads/${branch}`]);
    return { branch, commit, files, pr: await pullRequest(dir, branch, message, files, options.gh ?? process.env.JSCRAWL_GH ?? 'gh') };
  } finally {
    await rm(index, { force: true });
  }
}

/** The branch's open pull request, opened if it has none. */
async function pullRequest(dir: string, branch: string, message: string, files: string[], gh: string): Promise<string> {
  const open = await run(gh, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url'], { cwd: dir });
  if (open.stdout.trim()) return open.stdout.trim();
  const [title, ...rest] = message.split('\n');
  const body = [rest.join('\n').trim(), `Files:\n${files.map((file) => `- ${file}`).join('\n')}`].filter(Boolean).join('\n\n');
  const created = await run(gh, ['pr', 'create', '--head', branch, '--base', BASE, '--title', title, '--body', body], { cwd: dir });
  return created.stdout.trim().split('\n').pop()!;
}

export type SyncResult =
  | { synced: false; reason: string }
  | { synced: true; from: string; to: string; files: string[] };

/**
 * Fast-forwards the checkout to the remote's main, so merged crawlers reach the
 * crawls. Local work is kept: a file main changes that is edited (or untracked)
 * here holds the sync back, unless it already matches main - the usual case once
 * its pull request is merged.
 */
export async function syncCrawlers(dir: string): Promise<SyncResult> {
  if (!(await git(dir, ['remote']).catch(() => '')).split('\n').includes(REMOTE)) {
    return { synced: false, reason: `no ${REMOTE} remote` };
  }
  await git(dir, ['fetch', '--quiet', REMOTE, BASE]);
  const head = await git(dir, ['rev-parse', 'HEAD']);
  const target = await git(dir, ['rev-parse', `${REMOTE}/${BASE}`]);
  if (head === target) return { synced: false, reason: 'up to date' };
  if ((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])) !== BASE) {
    return { synced: false, reason: `the checkout is not on ${BASE}` };
  }
  const ahead = await git(dir, ['merge-base', '--is-ancestor', head, target]).then(() => false, () => true);
  if (ahead) return { synced: false, reason: `the checkout has commits ${REMOTE}/${BASE} does not` };

  const changed = (await git(dir, ['diff', '--name-only', head, target])).split('\n').filter(Boolean);
  const local = new Map(
    (await git(dir, ['status', '--porcelain', '--untracked-files=all', '--', ...changed]))
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(3), line.slice(0, 2)] as const)
  );
  for (const [file, state] of local) {
    const incoming = await git(dir, ['rev-parse', `${target}:${file}`]).catch(() => null);
    const here = await git(dir, ['hash-object', '--', file]).catch(() => null);
    if (incoming === null || here !== incoming) {
      return { synced: false, reason: `${file} has local changes that differ from ${BASE}` };
    }
    // identical to what main brings: make way for it
    if (state !== '??') await git(dir, ['reset', '--quiet', '--', file]);
    const tracked = await git(dir, ['cat-file', '-e', `HEAD:${file}`]).then(() => true, () => false);
    if (tracked) await git(dir, ['checkout', 'HEAD', '--', file]);
    else await rm(resolve(dir, file));
  }
  await git(dir, ['merge', '--ff-only', '--quiet', target]);
  return { synced: true, from: head, to: target, files: changed };
}
