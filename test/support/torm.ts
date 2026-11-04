// Stand-ins for the proxy tests: torm's HTTP API, whose instances are SOCKS5
// servers on this machine, and a site behind them.

import { createServer as createHttpServer, IncomingMessage, Server as HttpServer, ServerResponse } from 'http';
import { AddressInfo, connect, createServer, Server, Socket } from 'net';

async function listen(server: HttpServer | Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

const close = (server: HttpServer | Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/** A SOCKS5 server (CONNECT, no auth) that resolves every host name to 127.0.0.1. */
export async function startSocks(): Promise<{ port: number; connects: string[]; close(): Promise<void> }> {
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
      const host = type === 3 ? buffer.subarray(5, 5 + buffer[4]).toString() : [...buffer.subarray(4, 8)].join('.');
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

export interface FakeInstance {
  slot: number;
  pid: number;
  socksAddr: string;
  socksPort: number;
  owner?: string;
  exitCountry?: string;
}

/** torm's API over SOCKS servers it starts; `calls` lists what it was asked, e.g. `POST /instances/0/reload`. */
export async function startTorm() {
  const calls: string[] = [];
  const starts: { country: string | null; owner: string }[] = [];
  const instances = new Map<number, FakeInstance & { socks: Awaited<ReturnType<typeof startSocks>> }>();
  let nextSlot = 0;
  const reply = (res: ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const info = ({ socks: _socks, ...instance }: FakeInstance & { socks: unknown }) => instance;

  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    calls.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== 'Bearer torm-token') return reply(res, 401, { error: 'unauthorized' });
    const slot = Number(/^\/instances\/(\d+)/.exec(req.url ?? '')?.[1]);
    if (req.method === 'POST' && req.url === '/instances') {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      starts.push({ country: body.country, owner: body.owner });
      const socks = await startSocks();
      const instance = {
        slot: nextSlot++,
        pid: 4000 + nextSlot,
        socksAddr: '127.0.0.1',
        socksPort: socks.port,
        owner: body.owner,
        ...(body.country ? { exitCountry: body.country } : {}),
        socks,
      };
      instances.set(instance.slot, instance);
      return reply(res, 201, info(instance));
    }
    if (req.method === 'GET' && req.url === '/instances') return reply(res, 200, [...instances.values()].map(info));
    const instance = instances.get(slot);
    if (!instance) return reply(res, 404, { error: `no running instance matches slot ${slot}` });
    if (req.method === 'POST' && req.url?.endsWith('/reload')) return reply(res, 200, info(instance));
    if (req.method === 'DELETE') {
      instances.delete(slot);
      await instance.socks.close();
      return reply(res, 200, info(instance));
    }
    reply(res, 404, { error: 'not found' });
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    token: 'torm-token',
    calls,
    starts,
    instances,
    /** Adds an instance someone else started, as torm would list it. */
    adopt(instance: FakeInstance) {
      instances.set(instance.slot, { ...instance, socks: { port: 0, connects: [], close: async () => undefined } });
      nextSlot = Math.max(nextSlot, instance.slot + 1);
    },
    /** Stops an instance's SOCKS server without torm knowing, as a crashed tor would. */
    async crash(slot: number) {
      await instances.get(slot)!.socks.close();
    },
    async close() {
      for (const instance of instances.values()) await instance.socks.close();
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
    res.writeHead(status, { 'content-type': 'text/html' }).end(`<html><body>${status}</body></html>`);
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, port, hits, close: () => close(server) };
}
