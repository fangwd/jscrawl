// Shopify storefronts publish their catalogue as JSON: a product's own record at
// /products/<handle>.js (prices in cents) and a collection's listing at
// /collections/<handle>/products.json (250 a page). These helpers read both
// into the crawler database, so a Shopify crawler is its url rules plus what
// its theme adds (specs, assets, swatches).

import { DynamicRecord } from 'sqlex';
import { CrawlerDatabase, ProductInput, VariantInput } from '../database';
import { htmlText } from '../extract';
import { parseSitemapIndex } from '../sitemap';

export interface ShopifyVariant {
  id: number;
  title: string;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  options?: (string | null)[];
  sku?: string | null;
  barcode?: string | null;
  /** Cents. */
  price: number;
  compare_at_price?: number | null;
  available?: boolean;
  /** Grams. */
  weight?: number | null;
  featured_image?: { src?: string | null } | null;
}

/** /products/<handle>.js */
export interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  description?: string | null;
  vendor?: string | null;
  type?: string | null;
  tags?: string[];
  available?: boolean;
  options?: { name: string; values?: string[] }[];
  variants: ShopifyVariant[];
  images?: string[];
  media?: { src?: string | null; alt?: string | null }[];
}

/** One product of /collections/<handle>/products.json. */
export interface ShopifyListingProduct {
  id: number;
  handle: string;
  title?: string | null;
  vendor?: string | null;
  images?: { src?: string | null }[];
}

/** products.json's page size: a full page means another may follow. */
export const SHOPIFY_LISTING_PAGE_SIZE = 250;

/** A collection's products.json page. */
export function shopifyListingUrl(origin: string, handle: string, page: number): string {
  return `${origin}/collections/${handle}/products.json?limit=${SHOPIFY_LISTING_PAGE_SIZE}&page=${page}`;
}

/** A product's .js record, checked; throws with the url when it is not one. */
export function parseShopifyProduct(text: string, url: string): ShopifyProduct {
  let json: ShopifyProduct;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${url} is not JSON`);
  }
  if (!json?.id || !Array.isArray(json.variants)) throw new Error(`${url} has no product id or variants`);
  return json;
}

/** A products.json page's products, checked; throws with the url when it is not one. */
export function parseShopifyListing(text: string, url: string): ShopifyListingProduct[] {
  let json: { products?: ShopifyListingProduct[] };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${url} is not JSON`);
  }
  if (!Array.isArray(json?.products)) throw new Error(`${url} has no products array`);
  return json.products;
}

/** The product and collection sitemaps a Shopify /sitemap.xml index lists. */
export async function shopifySitemaps(indexXml: string): Promise<{ products: string[]; collections: string[] }> {
  const files = await parseSitemapIndex(indexXml);
  const kind = (name: string) => files.filter((file) => new RegExp(`/sitemap_${name}_\\d+\\.xml`).test(new URL(file).pathname));
  return { products: kind('products'), collections: kind('collections') };
}

/** A cents amount in dollars. */
function cents(value?: number | null): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) / 100 : undefined;
}

/** A CDN image url without its version or size query, so one file is one image. */
export function shopifyImage(src?: string | null): string | undefined {
  if (!src) return undefined;
  return (src.startsWith('//') ? `https:${src}` : src).replace(/[?#].*$/, '');
}

/** A variant's value on option axis `index` (Shopify gives both shapes). */
function optionValue(variant: ShopifyVariant, index: number): string {
  const value = variant.options?.[index] ?? [variant.option1, variant.option2, variant.option3][index];
  return value === null || value === undefined ? '' : String(value).trim();
}

/**
 * A product's .js record as its product, option axes, variants and gallery.
 * `product` adds or overrides fields (a rating, a short description, the
 * page's JSON-LD); the description's markup is kept as an html asset. `pure`
 * tells, from an image's url and alt text, whether it shows the product alone
 * (undefined when it cannot tell). Returns the product and its variant records
 * by Shopify variant id, for images or dimensions a theme adds per variant.
 */
export function addShopifyProduct(
  db: CrawlerDatabase,
  json: ShopifyProduct,
  {
    category,
    product: extra = {},
    pure,
  }: {
    category?: DynamicRecord | null;
    product?: Partial<ProductInput>;
    pure?: (src: string, alt: string | undefined) => boolean | undefined;
  } = {}
): { product: DynamicRecord; variants: Map<number, DynamicRecord> } {
  const product = db.addProduct(
    {
      code: String(json.id),
      name: json.title,
      description: htmlText(json.description ?? '') || undefined,
      brand: json.vendor?.trim() || undefined,
      ...extra,
      structuredData: {
        shopify: { id: json.id, handle: json.handle, type: json.type, vendor: json.vendor, tags: json.tags },
        ...(extra.structuredData === undefined ? {} : { page: extra.structuredData }),
      },
    },
    { category, detailed: true }
  );
  if (json.description?.trim()) db.addProductAsset(product, 'html', 'Description', json.description.trim());

  // each option keeps its place: a variant's values are by position (option1..3).
  // A product without options has one, "Title" with the single value "Default Title".
  // Some themes list a whole range's values (sibling products' colours and
  // sizes) on each product: a value no variant carries is not this product's.
  const variants = json.variants.filter((variant) => variant?.id);
  const options = (json.options ?? [])
    .map((option, position) => {
      const carried = new Set(variants.map((variant) => optionValue(variant, position)));
      return { ...option, position, values: (option.values ?? []).filter((value) => carried.has(String(value).trim())) };
    })
    .filter((option) => option.name && option.values.length && !(option.values.length === 1 && option.values[0] === 'Default Title'));
  // a value is selectable while some variant carrying it is in stock
  const soldOut = new Set(options.flatMap((option) => option.values ?? []));
  for (const variant of variants) {
    if (variant.available !== false) options.forEach((option) => soldOut.delete(optionValue(variant, option.position)));
  }
  const axes = options.map((option) => {
    const { values } = db.addAttribute(product, {
      groupName: 'Options',
      name: option.name,
      values: (option.values ?? []).map((value) => ({ value, isAvailable: !soldOut.has(value) })),
    });
    return { position: option.position, values: new Map(values.map((value) => [String(value.get('value')), value])) };
  });

  const byId = new Map<number, DynamicRecord>();
  for (const variant of variants) {
    const input: VariantInput = {
      code: String(variant.id),
      name: variant.title === 'Default Title' ? undefined : variant.title,
      sku: variant.sku?.trim() || undefined,
      gtin: variant.barcode?.trim() || undefined,
      price: cents(variant.price),
      compareAtPrice: variant.compare_at_price && variant.compare_at_price > variant.price ? cents(variant.compare_at_price) : undefined,
      availability: variant.available === false ? 'out_of_stock' : 'in_stock',
      ...(variant.weight && variant.weight > 0 ? { weight: Math.round(variant.weight) / 1000, weightUnit: 'kg' } : {}),
    };
    const values = axes.map((axis) => axis.values.get(optionValue(variant, axis.position))).filter((value) => value !== undefined);
    byId.set(variant.id, db.addVariant(product, input, values));
  }

  const featuredBy = new Map<string, DynamicRecord[]>();
  for (const variant of variants) {
    const src = shopifyImage(variant.featured_image?.src);
    if (src) featuredBy.set(src, [...(featuredBy.get(src) ?? []), byId.get(variant.id)!]);
  }
  const alts = new Map((json.media ?? []).map((media) => [shopifyImage(media.src), media.alt?.trim() || undefined]));
  const images = [...new Set((json.images ?? []).map((src) => shopifyImage(src)).filter((src) => src !== undefined))];
  images.forEach((src, index) =>
    db.addProductImage(product, src, index === 0 ? 'thumbnail' : 'gallery', featuredBy.get(src), pure?.(src, alts.get(src)))
  );
  return { product, variants: byId };
}

/**
 * One products.json page as listing basics - name, brand, thumbnail - each
 * linked to its product page (queueing it) and to `category` at its listing
 * position, `offset` being the products on earlier pages.
 */
export function addShopifyListing(
  db: CrawlerDatabase,
  items: ShopifyListingProduct[],
  { origin, category, offset, fromUrlId }: { origin: string; category: DynamicRecord | null; offset: number; fromUrlId: number }
): void {
  items.forEach((item, index) => {
    if (!item?.id || !item.handle) return;
    const product = db.addProduct(
      { code: String(item.id), name: item.title ?? undefined, brand: item.vendor?.trim() || undefined },
      { category, position: offset + index + 1 }
    );
    const thumbnail = shopifyImage(item.images?.[0]?.src);
    if (thumbnail) db.addProductImage(product, thumbnail, 'thumbnail');
    db.addProductUrl(product, `${origin}/products/${item.handle}`, fromUrlId);
  });
}
