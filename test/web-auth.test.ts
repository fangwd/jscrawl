import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { webHandler, WebDeps } from '../src/web/routes';

const API_TOKEN = 'test-api-token-0123456789';
let server: Server;
let base: string;

beforeAll(async () => {
  // no database: a refused call never reaches one
  server = createServer(webHandler({ apiToken: API_TOKEN } as WebDeps));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

test('every route needs the service token, before routing', async () => {
  for (const path of ['/api/overview', '/api/nope', '/api/login']) {
    expect((await fetch(`${base}${path}`)).status).toBe(401);
    expect((await fetch(`${base}${path}`, { headers: { authorization: 'Bearer wrong-token-0123456789' } })).status).toBe(401);
    // a dashboard cookie means nothing here
    expect((await fetch(`${base}${path}`, { headers: { cookie: 'jscrawl_session=abc' } })).status).toBe(401);
  }
});
