// The domain's records over HTTP: sqlex's REST API, compiled from the domain's
// resource configuration (DomainConfig.api) and mounted under /api/d/, with the
// OpenAPI document that describes it at /api/d/openapi.json. The dashboard's
// renderer reads records and the document from here (separate-core-app-impl.md
// §5.9, §8). The core adds its own site and url as read-only resources, so a
// domain row can embed the site it belongs to and the page it came from.

import { IncomingMessage, ServerResponse } from 'http';
import { Database } from 'sqlex';
import { Api, ApiConfig, createApi } from 'sqlex/api';
import { domain, UiHints } from '../core/domain';

export const DOMAIN_API_PATH = '/api/d';

/** The core's models, read-only, beside the domain's: what its rows refer to. */
const CORE_RESOURCES: ApiConfig<unknown>['resources'] = {
  Site: {
    read: { fields: ['id', 'name', 'currency', 'locale', 'scope'] },
    filter: { fields: ['id', 'name'] },
    sort: { fields: ['name'], default: ['name'] },
  },
  Url: {
    read: { fields: ['id', 'url', 'type', 'status', 'site'] },
    filter: { fields: ['id', 'site', 'type', 'status'] },
    sort: { fields: ['id'], default: ['id'] },
    include: { relations: ['site'] },
  },
};

export function createDomainApi(db: Database): Api<unknown> {
  const { resources, defaults } = domain().api;
  return createApi(db, {
    basePath: DOMAIN_API_PATH,
    defaults: { page: { defaultLimit: 50, maxLimit: 500 }, ...defaults },
    resources: withHintRelations(db, { ...CORE_RESOURCES, ...resources }, domain().ui ?? {}),
  });
}

type Resources = ApiConfig<unknown>['resources'];

/** Every path a hint walks, from the model it starts at. */
function hintPaths(ui: UiHints): [string, string][] {
  const paths: [string, string][] = [];
  for (const [model, hints] of Object.entries(ui.models ?? {})) {
    for (const path of [hints.title, hints.subtitle, hints.image, hints.groupBy, ...(hints.columns ?? [])]) {
      if (path) paths.push([model, path]);
    }
  }
  for (const { amount, currency } of ui.money ?? []) {
    const [model] = amount.split('.');
    paths.push([model, currency]);
  }
  return paths;
}

/**
 * The resources with every relation a hint walks embeddable, and the site
 * reference filterable on the models listed per site, so the renderer can resolve each
 * hint from the API alone (separate-core-app-impl.md §5.9).
 */
function withHintRelations(db: Database, resources: Resources, ui: UiHints): Resources {
  const out: Resources = Object.fromEntries(Object.entries(resources).map(([name, r]) => [name, { ...r }]));
  const include = (name: string, relation: string, depth: number) => {
    const resource = out[name];
    if (!resource) return;
    const current = resource.include ?? {};
    const relations = current.relations ?? [];
    resource.include = {
      ...current,
      relations: relations.includes(relation) ? relations : [...relations, relation],
      maxDepth: Math.max(current.maxDepth ?? 1, depth),
    };
  };
  for (const [start, path] of hintPaths(ui)) {
    let model = db.schema!.model(start);
    const segments = path.split('.');
    for (const [i, segment] of segments.slice(0, -1).entries()) {
      const field = model?.field(segment) as any;
      if (!model || !field) throw new Error(`ui hint ${start}.${path}: ${segment} is not a field of ${model?.name ?? start}`);
      include(model.name, segment, segments.length - 1 - i);
      model = field.referencedField?.model ?? field.throughField?.referencedField.model ?? field.referencingField?.model;
    }
  }
  for (const { model, perSite } of ui.nav ?? []) {
    const resource = out[model];
    if (!perSite || !resource) continue;
    // the model's reference to the site, whatever it is called
    const site = db.schema!.model(model)?.fields.find((f: any) => f.referencedField?.model.table.name === 'site')?.name;
    if (!site) throw new Error(`ui nav ${model} is listed per site, but has no reference to site`);
    const fields = resource.filter?.fields ?? [];
    if (!fields.includes(site)) resource.filter = { ...resource.filter, fields: [...fields, site] };
  }
  return out;
}

/** Serves a request under /api/d/. */
export async function serveDomainApi(api: Api<unknown>, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.pathname === `${DOMAIN_API_PATH}/openapi.json`) {
    const document = api.openapi({ title: `jscrawl ${domain().name} records`, version: String(domain().schema.version) });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    res.end(JSON.stringify(document));
    return;
  }
  const response = await api.handle(toRequest(req, url), {});
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** A web Request over the node request: the handler reads a URL, a method, headers and a body. */
function toRequest(req: IncomingMessage, url: URL): Request {
  const method = req.method ?? 'GET';
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const body = method === 'GET' || method === 'HEAD' ? undefined : (req as unknown as ReadableStream);
  return new Request(url.href, { method, headers, body, duplex: 'half' } as RequestInit);
}
