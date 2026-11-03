// The jscrawl server, for a deployment's `src/server.ts` to run after it has
// registered its domain (port: JSCRAWL_PORT, default 3120): the HTTP API (src/web), the crawl supervisor and scheduler,
// and the agent's tools at /mcp - served by a child process (src/mcp/server.ts),
// which runs agent-written crawler code and long typechecks away from the API and
// the running crawls. spidermake - the agent and the dashboard - is its caller.

import { ChildProcess, spawn } from 'child_process';
import { createServer } from 'http';
import { resolve } from 'path';
import { Database } from 'sqlex';
import { loadConfig } from '../core/config';
import { syncCrawlers } from '../core/crawlersRepo';
import { migrateDatabase } from '../core/migrate';
import { sitesDir } from '../core/sites';
import { Supervisor } from '../core/supervisor';
import { webHandler } from '../web/routes';

/** Starts the server; the deployment's domain must be registered first. */
export async function runServer(): Promise<void> {
  process.loadEnvFile();
  const config = loadConfig();
  const db = new Database(config.database);
  await migrateDatabase(db);
  const cwd = process.cwd();
  // per-database log dir: several servers (dbs) on one host must not share run ids' log files
  const dbName = (config.database.connection as { database?: string }).database ?? 'db';
  const supervisor = new Supervisor(db, { cwd, logDir: resolve(cwd, 'data/logs', dbName) });
  await supervisor.init();

  const port = Number(process.env.JSCRAWL_PORT ?? 3120);
  // only spidermake and scripts call this API; keep it off public interfaces
  const host = process.env.JSCRAWL_HOST ?? '127.0.0.1';
  const apiToken = process.env.JSCRAWL_API_TOKEN;
  if (!apiToken || apiToken.length < 16) {
    throw new Error('JSCRAWL_API_TOKEN must be set, at least 16 characters (openssl rand -hex 32)');
  }
  const tools = serveTools(cwd);
  const server = createServer(webHandler({ db, config, supervisor, cwd, apiToken, toolServer: tools.port }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  console.log(`jscrawl on http://${host}:${port} (the API under /api, the agent's tools at /mcp)`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      tools.stop();
      supervisor.shutdown().finally(() => process.exit(0));
    });
  }

  // bring merged crawlers into the checkout, then re-crawl the sites whose
  // crawlers ask for it (site.refresh), so a scheduled crawl runs what was merged
  let held: string | undefined;
  const sync = () =>
    syncCrawlers(sitesDir(config))
      .then((result) => {
        if (result.synced) console.log(`Synced crawlers/ to main: ${result.files.join(', ')}`);
        else if (result.reason !== held && !/^(up to date|no origin remote)$/.test(result.reason)) {
          console.warn(`crawlers/ not synced to main: ${result.reason}`);
        }
        held = result.synced ? undefined : result.reason;
      })
      .catch((err) => console.error('crawlers sync:', err));
  const refresh = () =>
    supervisor
      .refreshDue()
      .then((started) => {
        if (started.length > 0) console.log(`Started ${started.length} scheduled re-crawl(s): runs ${started.map((s) => s.runId).join(', ')}`);
      })
      .catch((err) => console.error('scheduled re-crawl:', err));
  const tick = () => sync().then(refresh);
  tick();
  setInterval(tick, 5 * 60 * 1000).unref();
}

/**
 * Runs the tool server as a child, started again when it exits on its own - a
 * crawler under test can take it down. It reports the port it took.
 */
function serveTools(cwd: string): { port: () => number | undefined; stop: () => void } {
  let child: ChildProcess;
  let port: number | undefined;
  let stopping = false;
  const start = () => {
    // the deployment's tool server entry, which registers its domain and calls runToolServer
    child = spawn(process.execPath, ['-r', 'ts-node/register', 'src/mcp/server.ts'], {
      cwd,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    child.on('message', (message: { toolServerPort?: number }) => {
      if (message.toolServerPort) port = message.toolServerPort;
    });
    child.on('exit', (code, signal) => {
      port = undefined;
      // Ctrl+C reaches the whole process group; this server is stopping too
      if (stopping || signal === 'SIGINT') return;
      console.error(`tool server exited (${signal ?? `code ${code}`}); restarting it in 2s`);
      setTimeout(start, 2000);
    });
  };
  start();
  return {
    port: () => port,
    stop: () => {
      stopping = true;
      child.kill('SIGTERM');
    },
  };
}
