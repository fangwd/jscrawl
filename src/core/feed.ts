// A site's catalogue as a product feed in Google's product data specification
// (CSV), with the extension columns aether's feed import reads: option_groups,
// product_attributes, category_position and variant_options, plus a companion
// categories file (product_type, description, image_link, sort_order), the two
// zipped together as one feed (docs/feed-format.md).
//
// Each variant is a row whose id is `<product code>` (the default variant) or
// `<product code>-<variant code>`; a product with several variants groups its
// rows by item_group_id. Variant axes are the attributes its variants are
// defined by. Of the other attributes, choices - a bound on selection, a repeat
// flag, a price delta or a default on a value - are add-on option groups, and
// the rest are product attributes.

import { strToU8, zipSync } from 'fflate';
import { Database } from 'sqlex';

export interface ProductFeed {
  products: string;
  categories: string;
  productCount: number;
  /** Products left out because they have no variant yet: listing basics whose page is not scraped. */
  skippedCount: number;
  rowCount: number;
  categoryCount: number;
  /** Rows (variants) or products missing what a storefront shows. */
  gaps: { rowsWithoutPrice: number; rowsWithoutAvailability: number; productsWithoutImage: number; productsWithoutCategory: number };
}

const PRODUCT_COLUMNS = [
  'id', 'item_group_id', 'title', 'description', 'price', 'sale_price', 'availability', 'product_type',
  'category_position', 'image_link', 'additional_image_link', 'gtin', 'shipping_weight', 'variant_options',
  'option_groups', 'product_attributes',
] as const;
const CATEGORY_COLUMNS = ['product_type', 'description', 'image_link', 'sort_order'] as const;

type Row = { [column: string]: string };

const AVAILABILITY: { [availability: string]: string } = {
  in_stock: 'in_stock',
  limited: 'in_stock',
  out_of_stock: 'out_of_stock',
  discontinued: 'out_of_stock',
  preorder: 'preorder',
  backorder: 'backorder',
};
const WEIGHT_UNITS = new Set(['kg', 'g', 'lb', 'oz']);

/**
 * The feed as one zip: categories.csv, then products.csv - the order an import
 * applies them in, so the categories exist before products are filed under them.
 */
export function feedZip(feed: ProductFeed): Uint8Array {
  return zipSync({ 'categories.csv': strToU8(feed.categories), 'products.csv': strToU8(feed.products) });
}

export async function exportFeed(db: Database, siteName: string): Promise<ProductFeed> {
  const [site] = await db.query<{ id: number; currency: string | null }[]>(
    'select id, currency from site where name = ?',
    siteName
  );
  if (!site) throw new Error(`No site named ${siteName}`);
  if (!site.currency) throw new Error(`Site ${siteName} has no currency`);
  const currency = site.currency.trim();
  const query = <T>(sql: string) => db.query<T[]>(sql, site.id);

  const categories = await query<{
    id: number; parent_id: number | null; name: string; description: string | null; sort_order: number; image: string | null;
  }>(
    `select c.id, c.parent_id, c.name, c.description, c.sort_order, iu.url as image
       from category c left join url iu on iu.id = c.image_id
      where c.site_id = ? order by c.id`
  );
  const byId = new Map(categories.map((c) => [c.id, c]));
  const pathOf = (id: number): string => {
    const names: string[] = [];
    const seen = new Set<number>();
    for (let c = byId.get(id); c && !seen.has(c.id); c = c.parent_id === null ? undefined : byId.get(c.parent_id)) {
      seen.add(c.id);
      // '>' separates path levels in product_type
      names.unshift(c.name.replace(/>/g, '›'));
    }
    return names.join(' > ');
  };

  const products = await query<{ id: number; code: string; name: string | null; description: string | null }>(
    `select id, code, name, description from product where site_id = ? and status = 'active' order by id`
  );
  const variants = group(
    await query<{
      id: number; product_id: number; code: string; gtin: string | null; price: string | null;
      compare_at_price: string | null; availability: string | null; weight: string | null; weight_unit: string | null;
    }>(
      `select v.id, v.product_id, v.code, v.gtin, v.price, v.compare_at_price, v.availability, v.weight, v.weight_unit
         from product_variant v join product p on p.id = v.product_id
        where p.site_id = ? order by v.product_id, v.sort_order, v.id`
    ),
    (v) => v.product_id
  );
  const attributes = group(
    await query<{
      id: number; product_id: number; group_name: string; name: string;
      min_select: number | null; max_select: number | null; allow_quantity: boolean;
    }>(
      `select a.id, a.product_id, g.name as group_name, a.name, a.min_select, a.max_select, a.allow_quantity
         from product_attribute a
         join product_attribute_group g on g.id = a.group_id
         join product p on p.id = a.product_id
        where p.site_id = ? order by a.product_id, g.sort_order, a.sort_order, a.id`
    ),
    (a) => a.product_id
  );
  const values = group(
    await query<{
      id: number; attribute_id: number; value: string; price_delta: string | null; is_default: boolean; is_available: boolean | null;
    }>(
      `select av.id, av.attribute_id, av.value, av.price_delta, av.is_default, av.is_available
         from product_attribute_value av
         join product_attribute a on a.id = av.attribute_id
         join product p on p.id = a.product_id
        where p.site_id = ? order by av.attribute_id, av.sort_order, av.id`
    ),
    (v) => v.attribute_id
  );
  const variantValues = group(
    await query<{ variant_id: number; attribute_value_id: number }>(
      `select vv.variant_id, vv.attribute_value_id
         from product_variant_value vv
         join product_variant v on v.id = vv.variant_id
         join product p on p.id = v.product_id
        where p.site_id = ?`
    ),
    (vv) => vv.variant_id
  );
  const images = group(
    await query<{ id: number; product_id: number; url: string; pure: boolean | null; role: string }>(
      `select pi.id, pi.product_id, u.url, pi.pure, pi.role
         from product_image pi join url u on u.id = pi.url_id join product p on p.id = pi.product_id
        where p.site_id = ? order by pi.product_id, pi.role <> 'thumbnail', pi.position, pi.id`
    ),
    (i) => i.product_id
  );
  const imageVariants = group(
    await query<{ image_id: number; variant_id: number }>(
      `select iv.image_id, iv.variant_id
         from product_image_variant iv join product_image pi on pi.id = iv.image_id join product p on p.id = pi.product_id
        where p.site_id = ?`
    ),
    (iv) => iv.image_id
  );
  const memberships = group(
    await query<{ product_id: number; category_id: number; position: number }>(
      `select pc.product_id, pc.category_id, pc.position
         from product_category pc join product p on p.id = pc.product_id
        where p.site_id = ? order by pc.product_id, pc.is_primary desc, pc.category_id`
    ),
    (m) => m.product_id
  );

  const rows: Row[] = [];
  let productCount = 0;
  let skippedCount = 0;
  const gaps = { rowsWithoutPrice: 0, rowsWithoutAvailability: 0, productsWithoutImage: 0, productsWithoutCategory: 0 };
  for (const product of products) {
    const productVariants = variants.get(product.id) ?? [];
    if (!productVariants.length) {
      skippedCount++;
      continue;
    }
    productCount++;
    const productAttributes = attributes.get(product.id) ?? [];
    const valueById = new Map(
      productAttributes.flatMap((a) => (values.get(a.id) ?? []).map((v) => [v.id, { attribute: a, value: v }] as const))
    );
    const axisIds = new Set(
      productVariants.flatMap((v) => (variantValues.get(v.id) ?? []).map((vv) => valueById.get(vv.attribute_value_id)?.attribute.id))
    );
    const others = productAttributes.filter((a) => !axisIds.has(a.id));
    const isChoice = (a: (typeof others)[number]) =>
      a.min_select !== null || a.max_select !== null || a.allow_quantity ||
      (values.get(a.id) ?? []).some((v) => v.price_delta !== null || v.is_default);
    // aether lists no sold-out add-on values, nor a group left without values
    const optionGroups = others.filter(isChoice).flatMap((a) => {
      const choosable = (values.get(a.id) ?? []).filter((v) => v.is_available !== false);
      if (!choosable.length) return [];
      return [{
        code: uniqueCode(a, others),
        name: a.name,
        min_select: Math.min(a.min_select ?? 0, choosable.length),
        max_select: a.max_select,
        values: choosable.map((v) => ({
          code: v.value,
          label: v.value,
          price_extra: v.price_delta ?? '0',
          is_default: v.is_default,
        })),
      }];
    });
    const specs = others.filter((a) => !isChoice(a));
    const productAttributeMap: { [name: string]: string } = {};
    for (const a of specs) {
      const shared = a.group_name && specs.some((b) => b !== a && b.name === a.name);
      const key = shared ? `${a.group_name}: ${a.name}` : a.name;
      productAttributeMap[key] = (values.get(a.id) ?? []).map((v) => v.value).join(', ');
    }

    const membership = (memberships.get(product.id) ?? [])[0];
    const productImages = images.get(product.id) ?? [];
    if (!membership) gaps.productsWithoutCategory++;
    if (!productImages.length) gaps.productsWithoutImage++;
    const grouped = productVariants.length > 1;
    productVariants.forEach((variant, index) => {
      const first = index === 0;
      const ownImages = rowImages(productImages, (i) => imageVariants.get(i.id)?.some((iv) => iv.variant_id === variant.id), imageVariants);
      const axes = (variantValues.get(variant.id) ?? [])
        .map((vv) => valueById.get(vv.attribute_value_id))
        .filter((entry) => entry !== undefined)
        // a pair is cut at its first ':' and pairs at '|'
        .map(({ attribute, value }) => `${attribute.name.replace(/[:|]/g, ' ')}:${value.value.replace(/\|/g, '/')}`);
      if (variant.price === null) gaps.rowsWithoutPrice++;
      if (!variant.availability || !AVAILABILITY[variant.availability]) gaps.rowsWithoutAvailability++;
      const onSale = variant.compare_at_price !== null && variant.price !== null && Number(variant.compare_at_price) > Number(variant.price);
      rows.push({
        id: variant.code ? `${product.code}-${variant.code}` : product.code,
        item_group_id: grouped ? product.code : '',
        title: first ? product.name ?? '' : '',
        description: first ? product.description ?? '' : '',
        price: money(onSale ? variant.compare_at_price : variant.price, currency),
        sale_price: onSale ? money(variant.price, currency) : '',
        availability: variant.availability ? AVAILABILITY[variant.availability] ?? '' : '',
        product_type: first && membership ? pathOf(membership.category_id) : '',
        category_position: first && membership ? String(membership.position) : '',
        image_link: ownImages[0] ? imageLink(ownImages[0].url) : '',
        additional_image_link: ownImages.slice(1).map((i) => imageLink(i.url)).join(','),
        gtin: variant.gtin ?? '',
        shipping_weight:
          variant.weight !== null && variant.weight_unit && WEIGHT_UNITS.has(variant.weight_unit)
            ? `${Number(variant.weight)} ${variant.weight_unit}`
            : '',
        variant_options: axes.join('|'),
        option_groups: first ? JSON.stringify(optionGroups) : '',
        product_attributes: first ? JSON.stringify(productAttributeMap) : '',
      });
    });
  }

  // parents before their children
  const categoryRows: Row[] = categories
    .map((c) => ({
      product_type: pathOf(c.id),
      description: c.description ?? '',
      image_link: c.image ? imageLink(c.image) : '',
      sort_order: String(c.sort_order),
    }))
    .sort((a, b) => (a.product_type < b.product_type ? -1 : a.product_type > b.product_type ? 1 : 0));

  return {
    products: csv(PRODUCT_COLUMNS, rows),
    categories: csv(CATEGORY_COLUMNS, categoryRows),
    productCount,
    skippedCount,
    rowCount: rows.length,
    categoryCount: categoryRows.length,
    gaps,
  };
}

/** The feed's gaps as one line, `no gaps` when there are none. */
export function describeGaps({ gaps }: ProductFeed): string {
  const parts = [
    gaps.rowsWithoutPrice && `${gaps.rowsWithoutPrice} rows without a price`,
    gaps.rowsWithoutAvailability && `${gaps.rowsWithoutAvailability} rows without availability`,
    gaps.productsWithoutImage && `${gaps.productsWithoutImage} products without an image`,
    gaps.productsWithoutCategory && `${gaps.productsWithoutCategory} products without a category`,
  ].filter(Boolean);
  return parts.length ? `gaps: ${parts.join(', ')}` : 'no gaps';
}

function group<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/** Images a feed row carries: image_link and additional_image_link together. */
export const MAX_ROW_IMAGES = 5;

/**
 * A variant row's images, at most MAX_ROW_IMAGES: pictures of the product alone
 * (pure) first, then unjudged ones, then the rest (scenes, props); at each of
 * those, the variant's own pictures before the whole product's, and otherwise
 * the thumbnail, then gallery order. A swatch comes last: it is never the main
 * picture. Pictures of other variants are left out.
 */
function rowImages<T extends { id: number; pure: boolean | null; role: string }>(
  images: T[],
  isOwn: (image: T) => boolean | undefined,
  imageVariants: Map<number, unknown>
): T[] {
  const purity = (image: T) => (image.pure === true ? 0 : image.pure === null ? 1 : 2);
  return images
    .filter((image) => isOwn(image) || !imageVariants.has(image.id))
    .map((image, order) => ({ image, order, own: isOwn(image) ? 0 : 1 }))
    .sort((a, b) =>
      Number(a.image.role === 'swatch') - Number(b.image.role === 'swatch') ||
      purity(a.image) - purity(b.image) ||
      a.own - b.own ||
      a.order - b.order
    )
    .slice(0, MAX_ROW_IMAGES)
    .map(({ image }) => image);
}

/** An option group's code: its name, qualified by its attribute group when another group repeats the name. */
function uniqueCode(a: { name: string; group_name: string }, all: { name: string }[]): string {
  return all.filter((b) => b.name === a.name).length > 1 ? `${a.group_name}: ${a.name}` : a.name;
}

/** A numeric column as read (a decimal string), so no float rounding. */
function money(amount: string | null, currency: string): string {
  return amount === null ? '' : `${amount} ${currency}`;
}

// commas separate additional_image_link, so a link's own are escaped
function imageLink(url: string): string {
  return url.replace(/,/g, '%2C');
}

function csv(columns: readonly string[], rows: Row[]): string {
  const cell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return [columns.join(','), ...rows.map((row) => columns.map((c) => cell(row[c] ?? '')).join(','))].join('\n') + '\n';
}
