// The jscrawl tool server: the domain tools (src/mcp/tools.ts) over MCP streamable
// HTTP at /mcp, for agents to mount as a remote server. The jscrawl server runs it
// as a supervised child (the deployment's src/mcp/server.ts, which registers its
// domain and calls runToolServer) and forwards its own /mcp here, so agents know
// only the jscrawl server's address.
//
// It listens on a free loopback port, which it reports to its parent and prints.
// Every request but GET /healthz needs JSCRAWL_API_TOKEN as a bearer.
//
// Stateless: each request gets a fresh MCP server over the shared tools, so no
// session state lives here and a restart loses nothing but calls in flight.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { Database } from 'sqlex';
import { loadConfig } from '../core/config';
import { sameSecret } from '../web/auth';
import { DomainTool, domainTools } from '../mcp/tools';

function version(): string {
  try {
    return JSON.parse(readFileSync('package.json', 'utf8')).version ?? '1.0.0';
  } catch {
    return '1.0.0';
  }
}

/** One process serves every agent session; the jscrawl server and the crawler children have their own pools. */
const POOL_LIMIT = 5;

function mcpServer(tools: DomainTool[], cwd: string): McpServer {
  const server = new McpServer({ name: 'jscrawl', version: version() });
  for (const tool of tools) {
    const config = {
      description: tool.description,
      inputSchema: tool.schema,
      annotations: { readOnlyHint: tool.readOnly ?? false },
    };
    server.registerTool(tool.name, config, async (args, extra) => {
      try {
        const text = await tool.execute(args, { cwd, signal: extra.signal });
        return { content: [{ type: 'text', text }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true };
      }
    });
  }
  return server;
}

/** Starts the tool server; the deployment's domain must be registered first. */
export async function runToolServer(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // run by the jscrawl server, which passes its environment down
  }
  const token = process.env.JSCRAWL_API_TOKEN;
  if (!token || token.length < 16) {
    throw new Error('JSCRAWL_API_TOKEN must be set, at least 16 characters (openssl rand -hex 32)');
  }
  // Same DATABASE_URL override as the CLI and server: jscrawl's tools must query
  // the database the app is actually using, not the docker default in config.
  const config = loadConfig();
  const connection = config.database.connection;
  const db = new Database({
    ...config.database,
    // sqlex parses URL strings itself. Spreading one drops its credentials.
    connection: typeof connection === 'string' ? connection : {
      ...connection,
      connectionLimit: Math.min(connection.connectionLimit ?? POOL_LIMIT, POOL_LIMIT),
    },
  });
  const cwd = process.cwd();
  const tools = domainTools({
    db,
    config,
    cwd,
    jscrawlUrl: process.env.JSCRAWL_URL ?? `http://127.0.0.1:${process.env.JSCRAWL_PORT ?? 3120}`,
    apiToken: token,
  });

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', tools: tools.length }));
      return;
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!bearer || !sameSecret(bearer, token)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    if (path !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    const mcp = mcpServer(tools, cwd);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error('tool server:', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Internal error' }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  process.send?.({ toolServerPort: port });
  console.log(`jscrawl tool server on http://127.0.0.1:${port}/mcp (${tools.length} tools)`);
}
