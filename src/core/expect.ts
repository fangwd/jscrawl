// What a crawler promises about its site's catalogue, from the request it was
// built for: how many products, and which fields every product carries. The
// build checks the fields on its product test pages; a finished crawl checks the
// whole catalogue, and a shortfall becomes an issue (see core/issues.ts).

import { Database } from 'sqlex';
import type { PreviewTable } from './preview';

export const EXPECTED_FIELDS = ['price', 'availability', 'image', 'category', 'description', 'brand'] as const;
export type ExpectedField = (typeof EXPECTED_FIELDS)[number];

export interface Expectations {
  /** The product count the request implies, as [min, max]. */
  products?: [number, number];
  /** Fields every product must carry; a crawl passes when 95% of its products do. */
  fields?: ExpectedField[];
}

/** The share of a crawl's products that must carry each required field. */
export const REQUIRED_SHARE = 0.95;

/** A crawler's `site.expect`, checked; throws naming what is wrong. */
export function parseExpectations(name: string, expect: unknown): Expectations {
  const fail = (why: string): never => {
    throw new Error(`crawlers/${name}.ts: site.expect${why}`);
  };
  if (typeof expect !== 'object' || expect === null || Array.isArray(expect)) fail(' must be an object');
  const { products, fields, ...rest } = expect as Record<string, unknown>;
  if (Object.keys(rest).length) fail(` has unknown keys: ${Object.keys(rest).join(', ')}`);
  if (products !== undefined) {
    const valid =
      Array.isArray(products) &&
      products.length === 2 &&
      products.every((n) => Number.isSafeInteger(n) && n >= 0) &&
      products[0] <= products[1];
    if (!valid) fail('.products must be [min, max], whole numbers with min <= max');
  }
  if (fields !== undefined) {
    if (!Array.isArray(fields) || fields.some((field) => !EXPECTED_FIELDS.includes(field))) {
      fail(`.fields must list some of: ${EXPECTED_FIELDS.join(', ')}`);
    }
  }
  return expect as Expectations;
}

/** What a product test page saved lacks of the required fields; a page that saved no product is not checked. */
export function pageShortfalls(expect: Expectations | undefined, tables: { [table: string]: PreviewTable }): string[] {
  const products = tables.product?.records ?? [];
  if (!expect?.fields?.length || products.length === 0) return [];
  const variants = (tables.product_variant?.records ?? []) as { price?: number | null; availability?: string | null }[];
  const has: Record<ExpectedField, boolean> = {
    price: variants.some((v) => typeof v.price === 'number' && v.price > 0),
    availability: variants.some((v) => !!v.availability),
    image: (tables.product_image?.count ?? 0) > 0,
    // a product's categories usually come from the listings that carry it, not its own page
    category: true,
    description: products.some((p: any) => typeof p.description === 'string' && p.description.trim() !== ''),
    brand: products.some((p: any) => !!p.brand),
  };
  return expect.fields.filter((field) => !has[field]).map((field) => `no ${field}`);
}

export interface CatalogueCounts {
  /** Active products with at least one variant: what the feed exports. */
  products: number;
  fields: Record<ExpectedField, number>;
}

export async function catalogueCounts(db: Database, siteId: number): Promise<CatalogueCounts> {
  const [row] = await db.query<Record<string, string>[]>(
    `select count(*) as products,
            count(*) filter (where exists (select 1 from product_variant v where v.product_id = p.id and v.price > 0)) as price,
            count(*) filter (where exists (select 1 from product_variant v where v.product_id = p.id and v.availability is not null)) as availability,
            count(*) filter (where exists (select 1 from product_image i where i.product_id = p.id)) as image,
            count(*) filter (where exists (select 1 from product_category c where c.product_id = p.id)) as category,
            count(*) filter (where nullif(trim(p.description), '') is not null) as description,
            count(*) filter (where p.brand_id is not null) as brand
       from product p
      where p.site_id = ? and p.status = 'active'
        and exists (select 1 from product_variant v where v.product_id = p.id)`,
    siteId
  );
  return {
    products: Number(row.products),
    fields: Object.fromEntries(EXPECTED_FIELDS.map((field) => [field, Number(row[field])])) as Record<ExpectedField, number>,
  };
}

/** Where a crawled catalogue falls short of its expectations, one sentence each; empty when it meets them. */
export function catalogueShortfalls(expect: Expectations | null | undefined, counts: CatalogueCounts): string[] {
  const shortfalls: string[] = [];
  if (expect?.products) {
    const [min, max] = expect.products;
    if (counts.products < min || counts.products > max) {
      shortfalls.push(`${counts.products} products were saved; the crawler expects ${min}-${max}`);
    }
  }
  for (const field of expect?.fields ?? []) {
    const missing = counts.products - counts.fields[field];
    if (counts.products > 0 && counts.fields[field] < REQUIRED_SHARE * counts.products) {
      shortfalls.push(
        `${missing} of ${counts.products} products (${Math.round((100 * missing) / counts.products)}%) have no ${field}; ` +
          `the crawler requires it on ${REQUIRED_SHARE * 100}%`
      );
    }
  }
  return shortfalls;
}
