import { resolve } from 'path';

import { Database, type ConnectionInfo } from 'sqlex';

import { crawlerLogDir } from '../src/entries/server';

test('URL-configured databases use separate log directories, matching object connections', async () => {
  const connections: ConnectionInfo[] = [
    { connection: 'postgres://admin:secret@127.0.0.1:5434/first' },
    { connection: 'postgresql://admin:secret@127.0.0.1:5434/second' },
    {
      dialect: 'postgres',
      connection: { host: '127.0.0.1', port: 5434, database: 'first' },
    },
  ];
  const databases = connections.map((connection) => new Database(connection));
  try {
    const dirs = databases.map((db) => crawlerLogDir(db, '/srv/jscrawl'));
    expect(dirs[0]).toBe(resolve('/srv/jscrawl/data/logs/first'));
    expect(dirs[1]).toBe(resolve('/srv/jscrawl/data/logs/second'));
    expect(dirs[0]).not.toBe(dirs[1]);
    expect(dirs[2]).toBe(dirs[0]);
  } finally {
    await Promise.all(databases.map((db) => db.end()));
  }
});

test.each(['../outside', '..', '.', 'shop/au', 'shop_au', 'shop au', 'shop%20au'])(
  'database name %s remains inside a single log directory',
  async (name) => {
    const url = new Database({
      connection: `postgres://admin:secret@127.0.0.1:5434/${encodeURIComponent(name)}`,
    });
    const object = new Database({
      dialect: 'postgres',
      connection: { database: name },
    });
    try {
      const root = resolve('/srv/jscrawl/data/logs');
      const directory = crawlerLogDir(object, '/srv/jscrawl');
      expect(directory).toBe(resolve(root, encodeURIComponent(name).replace(/\./g, '%2E')));
      expect(directory.slice(root.length + 1)).not.toContain('/');
      // URL parsing drops a `.` or `..` path as a dot segment, so the URL names no database
      const dotted = name === '.' || name === '..';
      expect(crawlerLogDir(url, '/srv/jscrawl')).toBe(dotted ? resolve(root, 'db') : directory);
    } finally {
      await Promise.all([url.end(), object.end()]);
    }
  },
);
