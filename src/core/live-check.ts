// The live check (separate-core-app-impl.md §5.7): fetches a url's page now with
// its site's crawler, scrapes it without saving, and compares the records it
// yields with those saved, table by table, matching rows by the natural keys the
// domain declares (DomainConfig.liveCheck). Run in a child process by the
// deployment's CLI (--live-check), since it runs the site's crawler code.

import { Database, Record as Row } from 'sqlex';
import type { Model } from 'sqlex';
import { CoreDatabase } from './base-database';
import { domain } from './domain';
import { Config } from './models';
import { getCrawler } from './utils';

export interface LiveCheck {
  url: string;
  httpStatus?: number;
  /** Why the page could not be fetched or scraped; nothing is compared then. */
  error?: string;
  /** Rows the page yields now that were not saved, by their key. */
  added: { table: string; key: string }[];
  /** Saved rows the page no longer yields. */
  removed: { table: string; key: string }[];
  changed: { table: string; key: string; column: string; saved: unknown; live: unknown }[];
  /** Rows compared per table. */
  compared: { table: string; live: number; saved: number }[];
}

export async function liveCheck(config: Config, urlId: number): Promise<LiveCheck> {
  // anything the scrape stamps from here on is the check's own clock (last seen, observed at)
  const started = Date.now();
  const keys = domain().liveCheck?.keys;
  if (!keys) throw new Error(`The ${domain().name} domain declares no live check`);
  const probe = new Database(config.database);
  const [row] = await probe.query<{ url: string; site: string }[]>(
    'select u.url, s.name as site from url u join site s on s.id = u.site_id where u.id = ?',
    urlId
  );
  await probe.end();
  if (!row) throw new Error(`No url ${urlId}`);

  const crawler = await getCrawler(config, row.site);
  const db = crawler.db as CoreDatabase;
  const result: LiveCheck = { url: row.url, added: [], removed: [], changed: [], compared: [] };
  try {
    const url = await db.getUrl(String(urlId));
    await crawler.bootstrap();
    const response = await crawler.fetchPage(url.url);
    result.httpStatus = response.statusCode;
    if (response.statusCode >= 400) {
      result.error = `HTTP ${response.statusCode}`;
      return result;
    }
    await crawler.scrape(response, url);
    for (const [table, key] of Object.entries(keys)) {
      await compareTable(db, table, key, keys, urlId, started, result);
    }
    return result;
  } catch (err: any) {
    result.error = String(err?.message ?? err);
    return result;
  } finally {
    await crawler.close();
    await db.end();
  }
}

/** A row's key: its values in the key's order, as text. */
const keyOf = (values: unknown[]) => JSON.stringify(values.map((v) => (v === null || v === undefined ? null : String(v))));
const showKey = (key: string) => (JSON.parse(key) as (string | null)[]).map((v) => v ?? '-').join(' / ');

function liveValue(record: Row, path: string[], table: string): unknown {
  let value: unknown = record;
  for (const [i, segment] of path.entries()) {
    if (!(value instanceof Row)) throw new Error(`live check key ${table}.${path.join('.')}: ${path.slice(0, i).join('.')} is not a record`);
    value = value.get(segment);
  }
  return value instanceof Row ? value.get('id') : value;
}

interface Column {
  field: string;
  column: string;
}

/** The scalar fields of a model, by sqlex field name and column. */
function scalarColumns(model: Model): Column[] {
  return model.fields
    .filter((f: any) => f.column && !f.referencedField)
    .map((f: any) => ({ field: f.name, column: f.column.name }));
}

/**
 * SQL for a table's saved rows with their key values (k0, k1, ...), joining
 * along the key's paths, kept to the site wherever a joined model has a site.
 */
function savedRowsSql(db: CoreDatabase, table: string, key: string[]) {
  const root = db.schema!.model(table);
  if (!root) throw new Error(`live check: no table ${table}`);
  const joins: string[] = [];
  const aliases = new Map<string, { alias: string; model: Model }>([['', { alias: 't0', model: root }]]);
  const exprs = key.map((path) => {
    const segments = path.split('.');
    let prefix = '';
    let at = aliases.get('')!;
    for (const segment of segments.slice(0, -1)) {
      const field = at.model.field(segment) as any;
      if (!field?.referencedField) throw new Error(`live check key ${table}.${path}: ${segment} is not a foreign key of ${at.model.name}`);
      const next = prefix ? `${prefix}.${segment}` : segment;
      if (!aliases.has(next)) {
        const alias = `t${aliases.size}`;
        const target: Model = field.referencedField.model;
        joins.push(`join ${target.table.name} ${alias} on ${alias}.${field.referencedField.column.name} = ${at.alias}.${field.column.name}`);
        aliases.set(next, { alias, model: target });
      }
      prefix = next;
      at = aliases.get(next)!;
    }
    const last = at.model.field(segments[segments.length - 1]) as any;
    if (!last?.column) throw new Error(`live check key ${table}.${path}: no column ${segments[segments.length - 1]} on ${at.model.name}`);
    return `${at.alias}.${last.column.name}`;
  });
  const siteScope = [...aliases.values()]
    .map(({ alias, model }) => {
      const site = model.fields.find((f: any) => f.referencedField?.model.table.name === 'site') as any;
      return site ? `${alias}.${site.column.name} = ?` : null;
    })
    .filter((s): s is string => s !== null);
  const select = `select t0.*, ${exprs.map((e, i) => `${e} as k${i}`).join(', ')} from ${table} t0 ${joins.join(' ')}`;
  return { root, select, exprs, siteScope };
}

/** A where clause matching any of the key tuples, or nothing for none. */
function anyOf(exprs: string[], tuples: unknown[][]): [string, unknown[]] {
  if (tuples.length === 0) return ['false', []];
  const clause = tuples.map(() => `(${exprs.map((e) => `${e} = ?`).join(' and ')})`).join(' or ');
  return [`(${clause})`, tuples.flat()];
}

/** How a page-owned table's rows link to their url: its foreign keys to url, and the join tables between them. */
function linkedToUrl(root: Model): string | null {
  const conditions: string[] = [];
  for (const field of root.fields as any[]) {
    if (field.referencedField?.model.table.name === 'url') conditions.push(`t0.${field.column.name} = ?`);
    const through = field.throughField;
    if (through?.referencedField.model.table.name === 'url') {
      const join = field.referencingField;
      conditions.push(
        `exists (select 1 from ${join.model.table.name} j where j.${join.column.name} = t0.${join.referencedField.column.name} and j.${through.column.name} = ?)`
      );
    }
  }
  return conditions.length ? `(${conditions.join(' or ')})` : null;
}

async function compareTable(
  db: CoreDatabase,
  table: string,
  key: string[],
  keys: Record<string, string[]>,
  urlId: number,
  started: number,
  result: LiveCheck
) {
  const paths = key.map((k) => k.split('.'));
  const live = new Map<string, Row>();
  for (const record of db.table(table).recordList) {
    live.set(keyOf(paths.map((p) => liveValue(record, p, table))), record);
  }

  const { root, select, exprs, siteScope } = savedRowsSql(db, table, key);
  const params: unknown[] = [];
  const scope = siteScope.map((clause) => (params.push(db.site.id), clause));
  const [matchKeys, matchParams] = anyOf(exprs, [...live.keys()].map((k) => JSON.parse(k)));
  // which saved rows the page should still yield: a page-owned table's rows
  // linked to the url; a child table's rows under the parents the page yields
  const parentIndexes = paths.flatMap((p, i) => (p.length > 1 ? [i] : []));
  let owned: [string, unknown[]] = ['false', []];
  if (parentIndexes.length === 0) {
    const link = linkedToUrl(root);
    if (link) owned = [link, Array(link.split('?').length - 1).fill(urlId)];
  } else {
    const parents = new Set<string>();
    for (const k of live.keys()) parents.add(keyOf(parentIndexes.map((i) => JSON.parse(k)[i])));
    // the parent table's own rows count too: a product whose variants all went
    const parentTable = (root.field(paths[parentIndexes[0]][0]) as any).referencedField.model.table.name;
    const parentKey = keys[parentTable];
    const rest = parentIndexes.map((i) => paths[i].slice(1).join('.'));
    if (parentKey && parentKey.length === rest.length && parentKey.every((p, i) => p === rest[i])) {
      const parentPaths = parentKey.map((p) => p.split('.'));
      for (const record of db.table(parentTable).recordList) parents.add(keyOf(parentPaths.map((p) => liveValue(record, p, parentTable))));
    }
    owned = anyOf(
      parentIndexes.map((i) => exprs[i]),
      [...parents].map((k) => JSON.parse(k))
    );
  }
  const where = [...scope, `(${matchKeys} or ${owned[0]})`].join(' and ');
  const rows = await db.query<any[]>(`${select} where ${where}`, ...params, ...matchParams, ...owned[1]);

  const saved = new Map<string, any>();
  for (const row of rows) saved.set(keyOf(key.map((_, i) => row[`k${i}`])), row);
  result.compared.push({ table, live: live.size, saved: saved.size });

  const columns = scalarColumns(root).filter((c) => c.field !== 'id');
  for (const [k, record] of live) {
    const row = saved.get(k);
    if (!row) {
      result.added.push({ table, key: showKey(k) });
      continue;
    }
    for (const { field, column } of columns) {
      const value = record.get(field);
      if (value === undefined) continue;
      // stamped by the check's own scrape (last seen, observed at): not the page's
      if (value instanceof Date && value.getTime() >= started) continue;
      if (!same(row[column], value)) result.changed.push({ table, key: showKey(k), column: field, saved: row[column], live: value });
    }
  }
  for (const k of saved.keys()) {
    if (!live.has(k)) result.removed.push({ table, key: showKey(k) });
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as any)[k])]));
  }
  return value;
}

/** Equal as stored: no value and empty text alike, numbers by value (decimals come back as text), dates by instant, JSON by content. */
export function same(saved: unknown, live: unknown): boolean {
  const none = (v: unknown) => v === null || v === undefined || v === '';
  if (none(saved) || none(live)) return none(saved) && none(live);
  if (saved instanceof Date || live instanceof Date) return new Date(saved as any).getTime() === new Date(live as any).getTime();
  if (typeof saved === 'object' || typeof live === 'object') return JSON.stringify(canonical(saved)) === JSON.stringify(canonical(live));
  const [a, b] = [Number(saved), Number(live)];
  if (saved !== '' && live !== '' && !Number.isNaN(a) && !Number.isNaN(b)) return a === b;
  return String(saved) === String(live);
}
