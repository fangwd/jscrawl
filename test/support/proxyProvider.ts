// Stand-ins for the proxy tests: a proxy provider whose proxies are SOCKS5
// servers on this machine, and a site behind them.

import {
  createServer as createHttpServer,
  IncomingMessage,
  Server as HttpServer,
  ServerResponse,
} from 'http';
import { AddressInfo, connect, createServer, Server, Socket } from 'net';

async function listen(server: HttpServer | Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

const close = (server: HttpServer | Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

/** A SOCKS5 server (CONNECT, no auth) that resolves every host name to 127.0.0.1. */
export async function startSocks(): Promise<{
  port: number;
  connects: string[];
  close(): Promise<void>;
}> {
  const connects: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let stage: 'greeting' | 'request' = 'greeting';
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting' && buffer.length >= 2 && buffer.length >= 2 + buffer[1]) {
        buffer = buffer.subarray(2 + buffer[1]);
        socket.write(Buffer.from([5, 0]));
        stage = 'request';
      }
      if (stage !== 'request' || buffer.length < 5) return;
      const type = buffer[3];
      const length = type === 3 ? 5 + buffer[4] + 2 : type === 1 ? 4 + 4 + 2 : Infinity;
      if (buffer.length < length) return;
      const host =
        type === 3
          ? buffer.subarray(5, 5 + buffer[4]).toString()
          : [...buffer.subarray(4, 8)].join('.');
      const port = buffer.readUInt16BE(length - 2);
      const rest = buffer.subarray(length);
      socket.off('data', onData);
      connects.push(`${host}:${port}`);
      const upstream = connect(port, '127.0.0.1', () => {
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (rest.length) upstream.write(rest);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
    };
    socket.on('data', onData);
    socket.on('error', () => undefined);
  });
  const port = await listen(server);
  return {
    port,
    connects,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await close(server);
    },
  };
}

export interface FakeProxy {
  id: number;
  url: string;
  type?: string;
  country?: string | null;
  owner?: string | null;
  status?: string;
}

/**
 * A proxy provider (docs/proxy-provider.md) whose proxies are SOCKS5 servers on
 * this machine; `calls` lists what it was asked, e.g. `POST /proxies/0/renew`.
 */
export async function startProvider() {
  const calls: string[] = [];
  const created: { type: string; country: string | null; owner: string }[] = [];
  const proxies = new Map<number, FakeProxy & { socks: Awaited<ReturnType<typeof startSocks>> }>();
  let nextId = 0;
  const reply = (res: ServerResponse, status: number, body?: unknown) =>
    body === undefined
      ? res.writeHead(status).end()
      : res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const info = ({ socks: _socks, ...proxy }: FakeProxy & { socks: unknown }) => proxy;

  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    calls.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== 'Bearer provider-token')
      return reply(res, 401, { error: 'unauthorized' });
    if (req.method === 'POST' && req.url === '/proxies') {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      created.push({
        type: body.type,
        country: body.country,
        owner: body.owner,
      });
      const socks = await startSocks();
      const proxy = {
        id: nextId++,
        url: `socks5h://127.0.0.1:${socks.port}`,
        type: body.type,
        country: body.country,
        owner: body.owner,
        socks,
      };
      proxies.set(proxy.id, proxy);
      return reply(res, 201, info(proxy));
    }
    if (req.method === 'GET' && req.url === '/proxies')
      return reply(res, 200, [...proxies.values()].map(info));
    const id = Number(/^\/proxies\/(\d+)/.exec(req.url ?? '')?.[1]);
    const proxy = proxies.get(id);
    if (!proxy) return reply(res, 404, { error: `no proxy ${id}` });
    if (req.method === 'POST' && req.url?.endsWith('/renew')) return reply(res, 200, info(proxy));
    if (req.method === 'DELETE') {
      proxies.delete(id);
      await proxy.socks.close();
      return reply(res, 204);
    }
    reply(res, 404, { error: 'not found' });
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    token: 'provider-token',
    calls,
    created,
    proxies,
    /** Adds a proxy someone else created, as the provider would list it. */
    adopt(proxy: FakeProxy) {
      proxies.set(proxy.id, {
        ...proxy,
        socks: { port: 0, connects: [], close: async () => undefined },
      });
      nextId = Math.max(nextId, proxy.id + 1);
    },
    /** Stops a proxy's SOCKS server without the provider knowing, as a crashed proxy would. */
    async crash(id: number) {
      await proxies.get(id)!.socks.close();
    },
    async close() {
      for (const proxy of proxies.values()) await proxy.socks.close();
      await close(server);
    },
  };
}

/** A site whose `/page` answers `statuses` in turn (the last repeats); robots.txt is absent. */
export async function startSite(statuses: number[]) {
  const hits: string[] = [];
  let served = 0;
  const server = createHttpServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/robots.txt') return res.writeHead(404).end();
    const status = statuses[Math.min(served++, statuses.length - 1)];
    res
      .writeHead(status, { 'content-type': 'text/html' })
      .end(`<html><body>${status}</body></html>`);
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () => close(server),
  };
}
