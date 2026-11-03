// What the core serves about its domain: the description the dashboard renders
// from (GET /api/domain), the agent's skills, the core's merged with the
// domain's (GET /api/skills), and the records API's relations its hints need.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { Database } from 'sqlex';
import { domain, useDomain } from '../src/core/domain';
import { agentSkills } from '../src/core/skills';
import { createDomainApi } from '../src/web/domainApi';
import { webHandler, WebDeps } from '../src/web/routes';
import { testDomain } from './support/domain';

const API_TOKEN = 'test-api-token-0123456789';
const dir = mkdtempSync(join(tmpdir(), 'jscrawl-skills-'));
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(webHandler({ apiToken: API_TOKEN } as WebDeps));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  useDomain(testDomain);
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${API_TOKEN}` } });

test('the domain description names its page types, inspect tool, actions and hints', async () => {
  useDomain({ ...testDomain, ui: { nav: [{ model: 'Page', label: 'Pages', perSite: true }] } });
  expect(await (await get('/api/domain')).json()).toEqual({
    name: 'test',
    urlTypes: ['page'],
    inspectTool: 'inspectPage',
    feed: false,
    liveCheck: false,
    ui: { nav: [{ model: 'Page', label: 'Pages', perSite: true }] },
  });
  expect((await fetch(`${base}/api/urls/1/live-check`, { method: 'POST', headers: { authorization: `Bearer ${API_TOKEN}` } })).status).toBe(404);
});

test("the domain's skills merge over the core's: new files added, a SKILL.md appended, the inspect tool filled in", async () => {
  write('domain/verify-url/SKILL.md', '---\nname: verify-url\ndescription: ignored\n---\n\n## In the test domain\n\nPages have titles.\n');
  write('domain/pages/SKILL.md', '---\nname: pages\ndescription: page things\n---\n\nUse jscrawl_{{inspectTool}}.\n');
  useDomain({ ...testDomain, skills: { dir: join(dir, 'domain'), instructions: 'Pages: ask jscrawl_{{inspectTool}}.' } });

  const skills = await agentSkills();
  expect(skills.inspectTool).toBe('inspectPage');
  expect(skills.instructions).toBe('Pages: ask jscrawl_inspectPage.');
  const files = Object.fromEntries(skills.files.map((f) => [f.path, f.content]));
  expect(files['pages/SKILL.md']).toContain('Use jscrawl_inspectPage.');
  // the core's verify-url, the domain's part after it, without its front matter
  expect(files['verify-url/SKILL.md']).toMatch(/^---\nname: verify-url\n/);
  expect(files['verify-url/SKILL.md']).toContain('jscrawl_inspectPage');
  expect(files['verify-url/SKILL.md'].trimEnd()).toMatch(/## In the test domain\n\nPages have titles\.$/);
  expect(files['verify-url/SKILL.md'].match(/^---$/gm)).toHaveLength(2);
  expect(Object.values(files).join('\n')).not.toContain('{{');

  const served = await (await get('/api/skills')).json();
  expect(served.files.map((f: { path: string }) => f.path)).toEqual(skills.files.map((f) => f.path));
});

test('a file both define, other than SKILL.md, is refused', async () => {
  write('clash/new-site/SKILL.md', 'more\n');
  write('clash/verify-url/notes.md', 'domain notes\n');
  write('core/verify-url/notes.md', 'core notes\n');
  write('core/verify-url/SKILL.md', 'core\n');
  useDomain({ ...domain(), skills: { dir: join(dir, 'clash') } });
  await expect(agentSkills(join(dir, 'core'))).rejects.toThrow('verify-url/notes.md is in both');
});

test('every relation a hint walks is embeddable, and a model listed per site filters by site', async () => {
  const db = new Database({
    dialect: 'postgres',
    connection: { host: '127.0.0.1', port: 5434, user: 'admin', password: 'secret', database: 'jscrawl_test' },
  });
  try {
    await db.buildSchema();
    useDomain({
      ...testDomain,
      api: { resources: { Page: { sort: { fields: ['id'], default: ['id'] } } } },
      ui: { nav: [{ model: 'Page', label: 'Pages', perSite: true }], models: { Page: { title: 'title', subtitle: 'url.site.name' } } },
    });
    const document = createDomainApi(db).openapi({ title: 'test', version: '1' }) as any;
    const parameters = document.paths['/pages'].get.parameters as { name: string; description?: string }[];
    expect(parameters.find((p) => p.name === 'include')?.description).toContain('url');
    expect(parameters.map((p) => p.name)).toContain('site');
    expect(document.paths['/urls'].get.parameters.find((p: any) => p.name === 'include')?.description).toContain('site');

    useDomain({ ...testDomain, ui: { models: { Page: { title: 'nope.title' } } } });
    expect(() => createDomainApi(db)).toThrow('ui hint Page.nope.title: nope is not a field of Page');
    useDomain({ ...testDomain, ui: { nav: [{ model: 'Site', label: 'Sites', perSite: true }] } });
    expect(() => createDomainApi(db)).toThrow('ui nav Site is listed per site, but has no reference to site');
  } finally {
    await db.end();
  }
});
