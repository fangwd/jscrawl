// The structured "everything we know about one url" report, shared by the
// agent's inspectUrl tool (which renders it as text) and the web API (which
// serves it as JSON). All queries are read-only.

import { readdir } from 'fs/promises';
import { Database } from 'sqlex';
import { sha1 } from './utils';
import { PageSnapshots } from './models';

// url.status meanings (see UrlStatus in src/core/models.ts).
export const URL_STATUS: { [code: number]: string } = {
  [-2]: 'scrape failed',
  [-1]: 'fetch failed',
  0: 'idle',
  1: 'busy',
  2: 'done',
  3: 'disallowed',
};

export interface UrlInfo {
  id: number;
  url: string;
  type: string;
  status: number;
  version: number;
  visitTime: Date | null;
  siteId: number;
  siteName: string;
  currency: string | null;
  locale: string | null;
  pageSnapshots: PageSnapshots;
}

export interface FetchInfo {
  fetchTime: Date;
  httpStatus: number | null;
  finalUrl: string | null;
  error: string | null;
  contentType: string | null;
  contentLength: number | null;
}

export interface PriceObservation {
  observedAt: Date;
  currency: string | null;
  price: number | null;
  compareAtPrice: number | null;
  availability: string | null;
}

export interface VariantInfo {
  id: number;
  code: string;
  name: string | null;
  sku: string | null;
  gtin: string | null;
  mpn: string | null;
  price: number | null;
  compareAtPrice: number | null;
  availability: string | null;
  stockQty: number | null;
  unitPrice: number | null;
  unit: string | null;
  weight: number | null;
  weightUnit: string | null;
  length: number | null;
  width: number | null;
  height: number | null;
  dimensionUnit: string | null;
  options: { axis: string; value: string }[];
  lastPrice: PriceObservation | null;
  /** Latest observations first, capped at 20. */
  priceHistory: PriceObservation[];
}

export interface AttributeInfo {
  groupName: string;
  name: string;
  minSelect: number | null;
  maxSelect: number | null;
  allowQuantity: boolean;
  values: { value: string; priceDelta: number | null; isDefault: boolean; isAvailable: boolean | null }[];
}

export interface ProductInfo {
  id: number;
  code: string;
  name: string | null;
  status: string;
  shortDescription: string | null;
  description: string | null;
  ratingValue: number | null;
  reviewCount: number | null;
  brand: string | null;
  structuredData: unknown;
  firstSeenAt: Date;
  lastSeenAt: Date;
  categories: { id: number; name: string; isPrimary: boolean; position: number; urlId: number | null; url: string | null }[];
  variants: VariantInfo[];
  attributes: AttributeInfo[];
  /** `variantIds` empty: a picture of the whole product. */
  images: { role: string; position: number; url: string; pure: boolean | null; variantIds: number[] }[];
  assets: { kind: string; name: string; value: string }[];
}

export interface ProductReport {
  site: { id: number; name: string; currency: string | null };
  product: ProductInfo;
  /** The pages the product was scraped from. */
  urls: { id: number; url: string; type: string; status: number }[];
}

export interface ListedProduct {
  id: number;
  code: string;
  name: string | null;
  status: string;
  pageUrlId: number | null;
  pageUrl: string | null;
  pageStatus: number | null;
}

export interface UrlReport {
  url: UrlInfo;
  lastFetch: FetchInfo | null;
  products: ProductInfo[];
  /** Products whose basics this listing page created (via its category row). */
  listed: ListedProduct[];
  /** Urls this page queued (url_graph out-edges): what a listing page produced. */
  queued: { id: number; url: string; type: string; status: number }[];
}

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function group<T>(rows: T[], key: (row: T) => number): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

/** Everything the database knows about one url (by url string or numeric id); null when unknown. */
export async function inspectUrl(db: Database, target: string | number, signal?: AbortSignal): Promise<UrlReport | null> {
  const isId = /^\d+$/.test(String(target));
  const data = await db.transaction(async (c) => {
    // the database enforces read-only, whatever the query does
    await c.query('set transaction read only');
    await c.query("set local statement_timeout = '30s'");
    const query = async <T = any[]>(statement: string, ...args: unknown[]): Promise<T> => {
      signal?.throwIfAborted();
      const rows = await c.query<T>(statement, ...args);
      signal?.throwIfAborted();
      return rows;
    };
    const [url] = await query<any[]>(
      `select u.id, u.site_id, u.type, u.status, u.version, u.url, u.visit_time,
              s.name as site_name, s.currency, s.locale, c.page_snapshots
         from url u join site s on s.id = u.site_id
         left join crawler c on c.id = s.crawler_id
        where ${isId ? 'u.id' : 'u.hash'} = ?`,
      isId ? Number(target) : sha1(String(target))
    );
    if (!url) return null;
    const id = url.id;
    const [fetch] = await query<any[]>(
      `select fetch_time, http_status, final_url, error, content_type, content_length
         from url_fetch where url_id = ? order by fetch_time desc limit 1`,
      id
    );
    const products = await productInfos(query, 'in (select product_id from product_url where url_id = ?)', id);
    const queued = await query<any[]>(
      `select d.id, d.url, d.type, d.status
         from url_graph g join url d on d.id = g.dst_id
        where g.src_id = ? order by d.id limit 100`,
      id
    );
    const listed = await query<any[]>(
      `select p.id, p.code, p.name, p.status, u.id as page_url_id, u.url as page_url, u.status as page_status
         from product_category pc
         join category c on c.id = pc.category_id
         join product p on p.id = pc.product_id
         left join product_url pu on pu.product_id = p.id
         left join url u on u.id = pu.url_id
        where c.url_id = ?
        order by p.id limit 200`,
      id
    );
    return { url, fetch, products, queued, listed };
  });

  if (!data) return null;

  const { url: u, fetch: f } = data;
  return {
    url: {
      id: Number(u.id),
      url: u.url,
      type: u.type,
      status: u.status,
      version: u.version,
      visitTime: u.visit_time ?? null,
      siteId: Number(u.site_id),
      siteName: u.site_name,
      currency: u.currency?.trim() ? u.currency.trim() : null,
      locale: u.locale,
      pageSnapshots: u.page_snapshots ?? 'gzip',
    },
    lastFetch: f
      ? {
          fetchTime: f.fetch_time,
          httpStatus: num(f.http_status),
          finalUrl: f.final_url ?? null,
          error: f.error ?? null,
          contentType: f.content_type ?? null,
          contentLength: num(f.content_length),
        }
      : null,
    products: data.products,
    queued: data.queued.map((d) => ({ id: Number(d.id), url: d.url, type: d.type, status: d.status })),
    listed: data.listed.map((p) => ({
      id: Number(p.id),
      code: p.code,
      name: p.name ?? null,
      status: p.status,
      pageUrlId: p.page_url_id != null ? Number(p.page_url_id) : null,
      pageUrl: p.page_url ?? null,
      pageStatus: p.page_status != null ? p.page_status : null,
    })),
  };
}

type Query = <T = any[]>(statement: string, ...args: unknown[]) => Promise<T>;

/** The products a scope selects (`in (...)` with one placeholder, bound to `arg`), fully assembled. */
async function productInfos(query: Query, scope: string, arg: unknown): Promise<ProductInfo[]> {
  const products = await query<any[]>(
    `select p.id, p.code, p.name, p.status, p.short_description, p.description, p.rating_value, p.review_count,
            b.name as brand, p.structured_data, p.first_seen_at, p.last_seen_at
       from product p left join brand b on b.id = p.brand_id
      where p.id ${scope} order by p.id`,
    arg
  );
  const categories = await query<any[]>(
    `select pc.product_id, c.id, c.name, pc.is_primary, pc.position, c.url_id, u.url as category_url
       from product_category pc
       join category c on c.id = pc.category_id
       left join url u on u.id = c.url_id
      where pc.product_id ${scope} order by pc.product_id, pc.is_primary desc, c.name`,
    arg
  );
  const variants = await query<any[]>(
    `select v.id, v.product_id, v.code, v.name, v.sku, v.gtin, v.mpn, v.price, v.compare_at_price,
            v.availability, v.stock_qty, v.unit_price, v.unit, v.weight, v.weight_unit,
            v.length, v.width, v.height, v.dimension_unit
       from product_variant v where v.product_id ${scope} order by v.product_id, v.sort_order, v.id`,
    arg
  );
  const variantValues = await query<any[]>(
    `select vv.variant_id, a.name as axis, av.value from product_variant_value vv
       join product_attribute_value av on av.id = vv.attribute_value_id
       join product_attribute a on a.id = av.attribute_id
      where a.product_id ${scope} order by vv.variant_id`,
    arg
  );
  const prices = await query<any[]>(
    `select vp.variant_id, vp.observed_at, vp.currency, vp.price, vp.compare_at_price, vp.availability
       from variant_price vp
      where vp.variant_id in (select v.id from product_variant v where v.product_id ${scope})
      order by vp.variant_id, vp.observed_at desc`,
    arg
  );
  const attributes = await query<any[]>(
    `select a.product_id, a.id, g.name as group_name, a.name, a.min_select, a.max_select, a.allow_quantity,
            av.value, av.price_delta, av.is_default, av.is_available
       from product_attribute a
       join product_attribute_group g on g.id = a.group_id
       left join product_attribute_value av on av.attribute_id = a.id
      where a.product_id ${scope}
      order by a.product_id, g.sort_order, a.sort_order, a.id, av.sort_order`,
    arg
  );
  const images = await query<any[]>(
    `select pi.product_id, pi.id, pi.role, pi.position, pi.pure, u.url as image_url,
            coalesce(array_agg(iv.variant_id) filter (where iv.variant_id is not null), '{}') as variant_ids
       from product_image pi
       join url u on u.id = pi.url_id
       left join product_image_variant iv on iv.image_id = pi.id
      where pi.product_id ${scope}
      group by pi.product_id, pi.id, pi.role, pi.position, pi.pure, u.url
      order by pi.product_id, pi.position`,
    arg
  );
  const assets = await query<any[]>(
    `select product_id, kind, name, value from product_asset
      where product_id ${scope} order by product_id, kind, name`,
    arg
  );

  const variantsByProduct = group(variants, (r) => Number(r.product_id));
  const valuesByVariant = group(variantValues, (r) => Number(r.variant_id));
  const historyByVariant = group(prices, (r) => Number(r.variant_id));
  const categoriesByProduct = group(categories, (r) => Number(r.product_id));
  const attrsByProduct = group(attributes, (r) => Number(r.product_id));
  const imagesByProduct = group(images, (r) => Number(r.product_id));
  const assetsByProduct = group(assets, (r) => Number(r.product_id));

  return products.map((p) => {
    const pid = Number(p.id);
    const attributeInfos: AttributeInfo[] = [];
    const attrById = new Map<number, AttributeInfo>();
    for (const a of attrsByProduct.get(pid) ?? []) {
      const aid = Number(a.id);
      let attr = attrById.get(aid);
      if (!attr) {
        attr = {
          groupName: a.group_name,
          name: a.name,
          minSelect: num(a.min_select),
          maxSelect: num(a.max_select),
          allowQuantity: a.allow_quantity === true,
          values: [],
        };
        attrById.set(aid, attr);
        attributeInfos.push(attr);
      }
      if (a.value != null) {
        attr.values.push({
          value: a.value,
          priceDelta: num(a.price_delta),
          isDefault: !!a.is_default,
          isAvailable: a.is_available ?? null,
        });
      }
    }
    return {
      id: pid,
      code: p.code,
      name: p.name ?? null,
      status: p.status,
      shortDescription: p.short_description ?? null,
      description: p.description ?? null,
      ratingValue: num(p.rating_value),
      reviewCount: num(p.review_count),
      brand: p.brand ?? null,
      structuredData: p.structured_data ?? null,
      firstSeenAt: p.first_seen_at,
      lastSeenAt: p.last_seen_at,
      categories: (categoriesByProduct.get(pid) ?? []).map((c) => ({
        id: Number(c.id),
        name: c.name,
        isPrimary: !!c.is_primary,
        position: Number(c.position),
        urlId: c.url_id != null ? Number(c.url_id) : null,
        url: c.category_url ?? null,
      })),
      variants: (variantsByProduct.get(pid) ?? []).map((v) => {
        const vid = Number(v.id);
        const history: PriceObservation[] = (historyByVariant.get(vid) ?? []).slice(0, 20).map((lp) => ({
          observedAt: lp.observed_at,
          currency: lp.currency?.trim() ? lp.currency.trim() : null,
          price: num(lp.price),
          compareAtPrice: num(lp.compare_at_price),
          availability: lp.availability ?? null,
        }));
        return {
          id: vid,
          code: v.code,
          name: v.name ?? null,
          sku: v.sku ?? null,
          gtin: v.gtin ?? null,
          mpn: v.mpn ?? null,
          price: num(v.price),
          compareAtPrice: num(v.compare_at_price),
          availability: v.availability ?? null,
          stockQty: num(v.stock_qty),
          unitPrice: num(v.unit_price),
          unit: v.unit ?? null,
          weight: num(v.weight),
          weightUnit: v.weight_unit ?? null,
          length: num(v.length),
          width: num(v.width),
          height: num(v.height),
          dimensionUnit: v.dimension_unit ?? null,
          options: (valuesByVariant.get(vid) ?? []).map((x) => ({ axis: x.axis, value: x.value })),
          lastPrice: history[0] ?? null,
          priceHistory: history,
        };
      }),
      attributes: attributeInfos,
      images: (imagesByProduct.get(pid) ?? []).map((im) => ({
        role: im.role,
        position: Number(im.position),
        url: im.image_url,
        pure: im.pure,
        variantIds: (im.variant_ids as unknown[]).map(Number),
      })),
      assets: (assetsByProduct.get(pid) ?? []).map((as) => ({ kind: as.kind, name: as.name, value: as.value })),
    };
  });
}

/** Everything the database knows about one product; null when unknown. */
export async function inspectProduct(db: Database, productId: number): Promise<ProductReport | null> {
  return db.transaction(async (c) => {
    await c.query('set transaction read only');
    await c.query("set local statement_timeout = '30s'");
    const query: Query = (statement, ...args) => c.query(statement, ...args);
    const [site] = await query<any[]>(
      'select s.id, s.name, s.currency from product p join site s on s.id = p.site_id where p.id = ?',
      productId
    );
    if (!site) return null;
    const [product] = await productInfos(query, '= ?', productId);
    const urls = await query<any[]>(
      `select u.id, u.url, u.type, u.status from product_url pu join url u on u.id = pu.url_id
        where pu.product_id = ? order by u.id`,
      productId
    );
    return {
      site: { id: Number(site.id), name: site.name, currency: site.currency?.trim() || null },
      product,
      urls: urls.map((u) => ({ id: Number(u.id), url: u.url, type: u.type, status: u.status })),
    };
  });
}

/** The saved HTML snapshots of a url (`<id>.<version>` file names) in a store directory, sorted. */
export async function listSnapshots(dir: string, urlId: number | string): Promise<string[]> {
  const prefix = `${urlId}.`;
  const names = await readdir(dir).catch(() => [] as string[]);
  // a snapshot's `.fetches` directory holds what its scrape fetched, not a page
  return names.filter((name) => name.startsWith(prefix) && !name.endsWith('.fetches')).sort();
}
