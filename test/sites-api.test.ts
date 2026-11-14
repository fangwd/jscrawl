import { createServer, Server } from 'http';
import { AddressInfo } from 'net';

import { SupervisorError } from '../src/core/supervisor';
import { webHandler, WebDeps } from '../src/web/routes';

const API_TOKEN = 'test-api-token-0123456789';
let server: Server;
let base: string;

/** Site 12 exists; the update names the thread count, then the site. */
const db = {
  query: jest.fn(async (_sql: string, _threadCount: number, id: number) =>
    id === 12 ? [{ id }] : [],
  ),
};
const supervisor = { liveCrawl: jest.fn(), restart: jest.fn() };

const patch = async (path: string, body: unknown, contentType = 'application/json') => {
  const response = await fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      'content-type': contentType,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

beforeAll(async () => {
  server = createServer(webHandler({ apiToken: API_TOKEN, db, supervisor } as unknown as WebDeps));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

beforeEach(() => {
  db.query.mockClear();
  supervisor.liveCrawl.mockReset().mockResolvedValue(null);
  supervisor.restart.mockReset();
});

test('a thread count is a whole number from 1 to 8, sent as JSON, for a site that exists', async () => {
  for (const threadCount of [0, 9, 2.5, '2']) {
    expect(await patch('/api/sites/12', { threadCount })).toEqual({
      status: 400,
      body: { error: 'threadCount must be a whole number from 1 to 8' },
    });
  }
  expect((await patch('/api/sites/12', { threadCount: 2 }, 'text/plain')).status).toBe(415);
  expect(await patch('/api/sites/99', { threadCount: 2 })).toEqual({
    status: 404,
    body: { error: 'No site 99' },
  });
  expect(supervisor.restart).not.toHaveBeenCalled();
});

test('saving without a running crawl only saves', async () => {
  expect(await patch('/api/sites/12', { threadCount: 3 })).toEqual({
    status: 200,
    body: { id: 12, threadCount: 3, restart: null },
  });
  expect(db.query).toHaveBeenCalledWith(
    expect.stringContaining('update site set thread_count'),
    3,
    12,
  );
  expect(supervisor.restart).not.toHaveBeenCalled();
});

test('saving restarts a running crawl, or says why it could not', async () => {
  supervisor.liveCrawl.mockResolvedValue(41);
  supervisor.restart.mockResolvedValue(42);
  expect((await patch('/api/sites/12', { threadCount: 4 })).body).toEqual({
    id: 12,
    threadCount: 4,
    restart: { runId: 42 },
  });
  expect(supervisor.restart).toHaveBeenCalledWith(12);

  supervisor.restart.mockRejectedValue(
    new SupervisorError(409, 'run 41 runs on another host: stop it there'),
  );
  expect(await patch('/api/sites/12', { threadCount: 5 })).toEqual({
    status: 200,
    body: {
      id: 12,
      threadCount: 5,
      restart: { skipped: 'run 41 runs on another host: stop it there' },
    },
  });
});
