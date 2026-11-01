import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Database } from 'sqlex';
import { sha1 } from '../src/core/utils';
import { webHandler, WebDeps } from '../src/web/routes';
import { startToolServer } from './support/toolServer';

const connection = {
  host: '127.0.0.1', port: 5434, user: 'admin', password: 'secret', database: 'jscrawl_test',
};
const db = new Database({ dialect: 'postgres', connection });
afterAll(() => db.end());
const TOKEN = 'test-api-token-0123456789';
const processEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));

test('the tool server answers health checks openly and everything else only with the token', async () => {
  const server = await startToolServer({ ...processEnv(), JSCRAWL_API_TOKEN: TOKEN });
  try {
    const health = await fetch(server.url.replace(/\/mcp$/, '/healthz'));
    expect(health.status).toBe(200);
    expect((await health.json()).tools).toBeGreaterThan(20);
    expect((await fetch(server.url, { method: 'POST' })).status).toBe(401);
    expect((await fetch(server.url, { method: 'POST', headers: { authorization: 'Bearer wrong-token-0123456789' } })).status).toBe(401);
    expect((await fetch(server.url, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);

    const client = new Client({ name: 'mcp-tools-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } })
    );
    const { tools } = await client.listTools();
    const sql = tools.find((tool) => tool.name === 'sql')!;
    expect(sql.annotations?.readOnlyHint).toBe(true);
    expect(sql.inputSchema.properties).toHaveProperty('query');
    expect(tools.find((tool) => tool.name === 'crawlStart')?.annotations?.readOnlyHint).toBe(false);
    await client.close();
  } finally {
    server.stop();
  }
}, 60_000);

test("agents reach the tools at the jscrawl server's /mcp, and /healthz is up once the tools are", async () => {
  const tools = await startToolServer({ ...processEnv(), JSCRAWL_API_TOKEN: TOKEN });
  let port: number | undefined;
  const server = createServer(webHandler({ apiToken: TOKEN, toolServer: () => port } as WebDeps));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // the child has not reported its port yet
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
    port = Number(new URL(tools.url).port);
    const health = await fetch(`${base}/healthz`);
    expect([health.status, (await health.json()).tools > 20]).toEqual([200, true]);
    expect((await fetch(`${base}/mcp`, { method: 'POST' })).status).toBe(401);

    const client = new Client({ name: 'mcp-forward-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } })
    );
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('checkCrawler');
    await client.close();
  } finally {
    server.close();
    tools.stop();
  }
}, 60_000);

test.each(['url', 'object'])('MCP database tools work with a %s connection', async (kind) => {
  const dir = mkdtempSync(join(tmpdir(), 'jscrawl-mcp-'));
  const site = `mcp-${kind}-${process.pid}`;
  const sitesDir = join(dir, 'sites');
  mkdirSync(sitesDir);
  writeFileSync(join(sitesDir, `${site}.ts`), "export const site = { currency: 'AUD' };\n");
  const configFile = join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    database: { dialect: 'postgres', connection }, store: {}, sites: { dir: sitesDir },
  }));
  const client = new Client({ name: 'mcp-database-test', version: '1.0.0' });
  const server = await startToolServer({
    ...processEnv(), JSCRAWL_API_TOKEN: TOKEN, JSCRAWL_CONFIG: configFile,
    DATABASE_URL: kind === 'url' ? 'postgres://admin:secret@127.0.0.1:5434/jscrawl_test' : '',
  });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  });
  const call = async (name: string, args: { [key: string]: unknown }) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
    const text = (result.content as { text?: string }[]).map((part) => part.text ?? '').join('\n');
    expect(result.isError ? text : null).toBeNull();
    return text;
  };
  try {
    await client.connect(transport);
    expect(await call('sql', { query: 'select current_database() as database' })).toContain('jscrawl_test');
    // Populate must initialize its own ORM schema in a fresh MCP process.
    expect(await call('populate', {})).toContain(`Registered ${site}`);
    expect(await call('populate', {})).toContain('Populated 1 site(s)');
    // No seed URL: coverage exercises database queries without external requests.
    expect(await call('coverage', { site })).toContain(`coverage: ${site}`);
    const pageUrl = `https://${site}.test/product`;
    const [url] = await db.query<{ id: string }[]>(
      `insert into url (site_id, type, url, hash)
       select id, 'product', ?, ? from site where name = ? returning id`,
      pageUrl, sha1(pageUrl), site
    );
    expect(await call('inspectUrl', { url: String(url.id) })).toContain(`url ${pageUrl}`);
  } finally {
    await client.close();
    server.stop();
    await db.query('delete from url where site_id in (select id from site where name = ?)', site);
    await db.query('delete from site where name = ?', site);
    await db.query('delete from crawler where name = ?', site);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
