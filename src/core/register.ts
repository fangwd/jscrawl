// Registers crawler modules with the domain database: the crawler/site rows and
// the optional SEED_URL. Shared by `--setup`, `jscrawl:populate` and the agent's
// populate tool, so creating a crawler and registering it cannot drift apart.

import { Database } from 'sqlex';
import { domain } from './domain';
import { Config, PageSnapshots } from './models';
import { siteModule, siteNames, sitesDir } from './sites';
import { sha1 } from './utils';

export interface Registration {
  name: string;
  seedUrl?: string;
  seeded: boolean;
  pageSnapshots: PageSnapshots;
}

/** Register or update one crawler, its site and its optional SEED_URL. */
export async function registerSite(db: Database, config: Config, name: string): Promise<Registration> {
  const { site = {}, SEED_URL } = siteModule(name, config);
  if (SEED_URL !== undefined && (typeof SEED_URL !== 'string' || !SEED_URL.trim())) {
    throw new Error(`crawlers/${name}.ts exports an invalid SEED_URL`);
  }
  const { currency, locale, scope, refresh, expect, ...rest } = site;
  // stored as jsonb; sqlex types a document column as plain JSON
  const expectations = expect === undefined ? null : (domain().expectations.parse(expect, name) as Record<string, any>);
  const settings = { ...rest, refreshMinutes: refresh === undefined ? null : refreshMinutes(name, refresh) };
  if (scope !== undefined && (typeof scope !== 'string' || !scope.trim())) {
    throw new Error(`crawlers/${name}.ts: scope must be a non-empty description`);
  }
  settings.pageSnapshots ??= 'gzip';
  if (!['gzip', 'raw', 'off'].includes(settings.pageSnapshots)) {
    throw new Error(`crawlers/${name}.ts: pageSnapshots must be gzip, raw, or off`);
  }
  settings.allow ??= [];
  settings.disallow ??= [];
  for (const path of [...settings.allow, ...settings.disallow]) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new Error(`crawlers/${name}.ts: allow and disallow rules are url paths starting with /, got ${JSON.stringify(path)}`);
    }
  }
  const crawler = (await db.table('crawler').upsert({ name, ...settings }, settings)).id;
  const row = await db.table('site').upsert(
    { name, crawler, currency: currency ?? null, locale: locale ?? null, scope: scope?.trim() ?? null, expect: expectations },
    { crawler, currency: currency ?? null, locale: locale ?? null, scope: scope?.trim() ?? null, expect: expectations }
  );
  let seeded = false;
  if (SEED_URL) {
    const hash = sha1(SEED_URL);
    const existing = await db.table('url').get({ hash });
    if (!existing) {
      db.table('url').append({ site: row.id, url: SEED_URL, hash, type: 'seed', priority: 1 });
      seeded = true;
    }
  }
  return { name, seedUrl: SEED_URL, seeded, pageSnapshots: settings.pageSnapshots };
}

const UNIT_MINUTES: Record<string, number> = { m: 1, h: 60, d: 24 * 60 };

/** `30m`, `6h` or `1d` in minutes. */
function refreshMinutes(name: string, refresh: unknown): number {
  const match = typeof refresh === 'string' ? /^(\d+)([mhd])$/.exec(refresh.trim()) : null;
  const minutes = match ? Number(match[1]) * UNIT_MINUTES[match[2]] : 0;
  if (!minutes) throw new Error(`crawlers/${name}.ts: refresh must be a duration like 30m, 6h or 1d, got ${JSON.stringify(refresh)}`);
  return minutes;
}

/** A crawler module that could not be registered, and why. */
export interface RegistrationFailure {
  name: string;
  error: string;
}

/**
 * Register every crawler module and flush the result. One that fails to load or
 * register - another session's half-written crawler - is reported, not fatal.
 */
export async function populateSites(
  db: Database,
  config: Config
): Promise<{ registrations: Registration[]; failures: RegistrationFailure[] }> {
  const names = siteNames(config);
  if (names.length === 0) throw new Error(`No site modules in ${sitesDir(config)}`);
  const registrations: Registration[] = [];
  const failures: RegistrationFailure[] = [];
  for (const name of names) {
    try {
      registrations.push(await registerSite(db, config, name));
    } catch (err: any) {
      failures.push({ name, error: String(err?.message ?? err).split('\n')[0] });
    }
  }
  await db.flush();
  return { registrations, failures };
}

export function describeRegistration({ name, seedUrl, seeded, pageSnapshots }: Registration): string {
  const seed = seedUrl ? `${seeded ? 'queued' : 'already queued'} seed ${seedUrl}` : 'no SEED_URL';
  return `Registered ${name} (${seed}; page snapshots: ${pageSnapshots})`;
}

export function describeFailure({ name, error }: RegistrationFailure): string {
  return `Could not register ${name}: ${error}`;
}
