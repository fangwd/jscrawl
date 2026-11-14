import { mkdir, mkdtemp, realpath, rm, symlink } from 'fs/promises';
import { platform, tmpdir } from 'os';
import { join } from 'path';

import { disksHolding, realPaths, treeUsage } from '../src/core/system';

test('a path through a symlink is the one it points to, and one not created yet resolves through its parent', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'system-')));
  try {
    await mkdir(join(root, 'disk2/html'), { recursive: true });
    await mkdir(join(root, 'app'));
    await symlink(join(root, 'disk2'), join(root, 'app/data'));
    expect(
      await realPaths({
        checkout: join(root, 'app'),
        'saved pages': join(root, 'app/data/html'),
        'saved images': join(root, 'app/data/images/new'),
      }),
    ).toEqual({
      checkout: join(root, 'app'),
      'saved pages': join(root, 'disk2/html'),
      'saved images': join(root, 'disk2/images/new'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('each path is on the filesystem mounted deepest above it, and a disk lists what it holds', () => {
  const fs = (mount: string, size: number) => ({
    fs: mount,
    type: 'ext4',
    size,
    used: 1,
    available: size - 1,
    use: 0,
    mount,
    rw: true,
  });
  const disks = disksHolding([fs('/', 100), fs('/srv', 500), fs('/srv/data', 900)], {
    checkout: '/srv/app',
    logs: '/srv/app/data/logs',
    'saved pages': '/srv/data/html',
    elsewhere: '/srvx/other',
  });
  expect(disks.map(({ mount, holds, size }) => ({ mount, holds, size }))).toEqual([
    { mount: '/srv', holds: ['checkout', 'logs'], size: 500 },
    { mount: '/srv/data', holds: ['saved pages'], size: 900 },
    { mount: '/', holds: ['elsewhere'], size: 100 },
  ]);
});

test("a run's usage sums its process and everything it started, and nothing else", () => {
  const list = [
    { pid: 10, parentPid: 1, cpu: 4, memRss: 1000 },
    { pid: 11, parentPid: 10, cpu: 2, memRss: 3000 },
    { pid: 12, parentPid: 11, cpu: 2, memRss: 2000 },
    { pid: 20, parentPid: 1, cpu: 50, memRss: 9000 },
  ];
  const cpu = platform() === 'linux' ? 8 : 4;
  expect(treeUsage(list, 10, 2)).toEqual({
    cpu,
    memory: 6000 * 1024,
    processes: 3,
  });
  expect(treeUsage(list, 99, 2)).toBeNull();
});
