// The host's load, for an operator deciding which crawls to stop: CPU, memory,
// the disks holding the server's files, the database's size, and what each live
// run on this host takes - its process and every process it started (a
// crawl's browser).

import { realpath } from 'fs/promises';
import { availableParallelism, hostname, loadavg, platform, uptime } from 'os';
import { basename, dirname, join, resolve, sep } from 'path';

import { Database } from 'sqlex';
import * as si from 'systeminformation';

import type { LiveRun } from './supervisor';

export interface Disk {
  mount: string;
  /** What of the server's is on it: 'checkout', 'logs', 'saved pages', 'saved images'. */
  holds: string[];
  size: number;
  used: number;
  available: number;
}

/** A run's process tree: CPU in percent of the whole machine, as the host's, and resident memory in bytes. */
export interface RunUsage {
  cpu: number;
  memory: number;
  processes: number;
}

export interface SystemReport {
  host: string;
  uptime: number;
  /** usage: percent of the whole machine; load: the 1, 5 and 15 minute averages. */
  cpu: { cores: number; usage: number; load: number[] };
  memory: { total: number; available: number };
  disks: Disk[];
  database: { size: number };
  /** null where the run is on another host, or its process is gone. */
  runs: (LiveRun & { usage: RunUsage | null })[];
}

export async function systemReport(
  db: Pick<Database, 'query'>,
  paths: { [what: string]: string },
  runs: LiveRun[],
): Promise<SystemReport> {
  const cores = availableParallelism();
  const [cpu, memory, filesystems, processes, [database], real] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    runs.some((run) => run.local) ? si.processes() : null,
    db.query<{ size: string }[]>('select pg_database_size(current_database()) as size'),
    realPaths(paths),
  ]);
  return {
    host: hostname(),
    uptime: uptime(),
    cpu: { cores, usage: cpu.currentLoad, load: loadavg() },
    memory: { total: memory.total, available: memory.available },
    disks: disksHolding(filesystems, real),
    database: { size: Number(database.size) },
    runs: runs.map((run) => ({
      ...run,
      usage:
        run.local && run.pid != null && processes
          ? treeUsage(processes.list, run.pid, cores)
          : null,
    })),
  };
}

/**
 * The paths with their symlinks followed, so each is matched to the disk it is
 * really on. One not created yet resolves through its nearest existing parent:
 * the disk it will be created on.
 */
export async function realPaths(paths: {
  [what: string]: string;
}): Promise<{ [what: string]: string }> {
  const real = async (path: string): Promise<string> => {
    try {
      return await realpath(path);
    } catch (err) {
      const parent = dirname(path);
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path) throw err;
      return join(await real(parent), basename(path));
    }
  };
  const entries = await Promise.all(
    Object.entries(paths).map(async ([what, path]) => [what, await real(resolve(path))]),
  );
  return Object.fromEntries(entries);
}

/** The filesystems the paths are on - each the one mounted deepest above it. */
export function disksHolding(
  filesystems: si.Systeminformation.FsSizeData[],
  paths: { [what: string]: string },
): Disk[] {
  const disks = new Map<string, Disk>();
  for (const [what, path] of Object.entries(paths)) {
    const absolute = resolve(path);
    const fs = filesystems
      .filter(
        ({ mount }) =>
          absolute === mount || absolute.startsWith(mount.endsWith(sep) ? mount : mount + sep),
      )
      .sort((a, b) => b.mount.length - a.mount.length)[0];
    if (!fs) continue;
    const disk = disks.get(fs.mount) ?? {
      mount: fs.mount,
      holds: [],
      size: fs.size,
      used: fs.used,
      available: fs.available,
    };
    disk.holds.push(what);
    disks.set(fs.mount, disk);
  }
  return [...disks.values()];
}

type ProcessData = si.Systeminformation.ProcessesProcessData;

/** A process of a run's tree: `depth` 0 is the run's own, 1 what it started, and so on. */
export interface RunProcess {
  pid: number;
  parentPid: number;
  depth: number;
  name: string;
  command: string;
  /** Percent of the whole machine, as the host's. */
  cpu: number;
  /** Resident memory in bytes. */
  memory: number;
  started: string;
  state: string;
}

/** The process and its descendants, each parent before its children; null when it is gone. */
function descendants<T extends Pick<ProcessData, 'pid' | 'parentPid'>>(
  list: T[],
  pid: number,
): { process: T; depth: number }[] | null {
  const children = new Map<number, T[]>();
  for (const process of list) {
    const siblings = children.get(process.parentPid);
    if (siblings) siblings.push(process);
    else children.set(process.parentPid, [process]);
  }
  const root = list.find((process) => process.pid === pid);
  if (!root) return null;
  const tree: { process: T; depth: number }[] = [];
  const walk = (process: T, depth: number) => {
    tree.push({ process, depth });
    for (const child of children.get(process.pid) ?? []) walk(child, depth + 1);
  };
  walk(root, 0);
  return tree;
}

/** A process's CPU is a share of the machine on Linux, of one core elsewhere (ps). */
const machineShare = (cpu: number, cores: number) => (platform() !== 'linux' ? cpu / cores : cpu);

/** The process and its descendants, summed; null when it is gone. */
export function treeUsage(
  list: Pick<ProcessData, 'pid' | 'parentPid' | 'cpu' | 'memRss'>[],
  pid: number,
  cores: number,
): RunUsage | null {
  const tree = descendants(list, pid);
  if (!tree) return null;
  const usage = { cpu: 0, memory: 0, processes: tree.length };
  for (const { process } of tree) {
    usage.cpu += machineShare(process.cpu, cores);
    usage.memory += process.memRss * 1024;
  }
  return usage;
}

/** The process tree of a run on this host, its own process first; null when the process is gone. */
export async function runProcesses(pid: number): Promise<RunProcess[] | null> {
  const cores = availableParallelism();
  const tree = descendants((await si.processes()).list, pid);
  return (
    tree?.map(({ process, depth }) => ({
      pid: process.pid,
      parentPid: process.parentPid,
      depth,
      name: process.name,
      command: [process.command, process.params].filter(Boolean).join(' '),
      cpu: machineShare(process.cpu, cores),
      memory: process.memRss * 1024,
      started: process.started,
      state: process.state,
    })) ?? null
  );
}
