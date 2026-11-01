import {
  Database,
  DynamicRecord,
  Record,
  ConnectionPool,
  ConnectionInfo,
  Filter,
  Schema,
} from 'sqlex';
import { Site, SiteUrl, UrlStatus } from './models';
import { allowAll, pathRules, PathRules } from './robots';
import { sha1, trimTitle } from './utils';
import type { Breadcrumb, ProductData, SpecPair } from './extract';

type Value = string | number | Date | boolean | null;
type FieldMap = { [key: string]: Value | Record };
type UrlFilter = { [key: string]: Value | Value[] };

export interface ProductInput {
  code: string;
  name?: string;
  shortDescription?: string;
  description?: string;
  brand?: string;
  ratingValue?: number;
  reviewCount?: number;
  structuredData?: unknown;
}

export type Availability =
  | 'in_stock'
  | 'out_of_stock'
  | 'limited'
  | 'preorder'
  | 'backorder'
  | 'discontinued';

export interface VariantInput {
  code?: string; // '' (default) = the product's default variant
  name?: string;
  sku?: string;
  gtin?: string;
  mpn?: string;
  price?: number;
  compareAtPrice?: number;
  priceType?: string;
  saleEndsAt?: Date;
  unitPrice?: number;
  unit?: string;
  availability?: Availability;
  stockQty?: number;
  weight?: number;
  weightUnit?: string;
  length?: number;
  width?: number;
  height?: number;
  dimensionUnit?: string;
}

export interface AttributeValueInput {
  value: string;
  priceDelta?: number;
  isDefault?: boolean;
  isAvailable?: boolean;
}

export interface AttributeInput {
  groupName?: string;
  name: string;
  minSelect?: number;
  maxSelect?: number;
  /** A value may be chosen more than once ("2x extra cheese"); min/max then count units. */
  allowQuantity?: boolean;
  values: (string | AttributeValueInput)[];
}

export interface CategoryDetails {
  description?: string;
  /** The category's picture. */
  image?: string;
  /** Its position among its siblings. */
  sortOrder?: number;
}

export interface CategoryNode {
  name: string;
  /** Headings without a page pass their children to the enclosing category. */
  url?: string;
  children?: CategoryNode[];
}

// Child rows a product detail page owns; re-scraping the page replaces them:
// what the page no longer shows (a dropped size, an image served from a new url)
// goes, what it still shows keeps its row. Not the price history (variant_price),
// which a kept variant keeps, nor categories, which listings give too.
const PRODUCT_DETAILS = [
  'product',
  'product_attribute_group',
  'product_attribute',
  'product_attribute_value',
  'product_asset',
  'product_image',
  'product_image_variant',
  'product_variant',
  'product_variant_value',
];

// A busy url whose claim is older than this was abandoned by a crashed crawler.
const STALE_CLAIM_MS = 30 * 60 * 1000;

const PRICE_FIELDS = [
  'price',
  'compareAtPrice',
  'priceType',
  'saleEndsAt',
  'unitPrice',
  'unit',
  'availability',
] as const;

export class CrawlerDatabase extends Database {
  site: Site;
  baseUrl: string;
  hashUrl: (href: string) => string;
  /** The crawler's own path rules: whether a category or product url may be queued and fetched. */
  allows: PathRules = allowAll;
  /** The url_fetch row of the page being scraped; price observations link to it. */
  urlFetch: Record | null = null;

  private observedAt = new Date();
  private detailedProducts = new Set<Record>();
  /** The membership each detailed product's own page files it under. */
  private primaryCategories = new Map<Record, DynamicRecord>();
  private attributeCount = new Map<Record, number>();
  private groupCount = new Map<Record, number>();
  /** Buffered attribute groups per product, so a group keeps one sort_order. */
  private groupRecords = new Map<Record, Map<string, Record>>();
  private imageCount = new Map<Record, number>();
  private variantCount = new Map<Record, number>();
  /**
   * Category ids by url hash. `category.url_id` is unique, but a flush matches
   * buffered records against the database before the url they reference has an
   * id, so a category a later page re-references is inserted a second time and
   * the flush dies on `category_url_id_key`. Appending with the id we already
   * know makes it an update. Shared with clones, so crawl threads agree.
   */
  private categories = new Map<string, number>();

  /**
   * The type of every url of this site that is already queued, by hash. A link
   * is queued from every page that carries it, and the type is a guess from the
   * url shape, so queueing must not change the type of a url that is already
   * queued: every page links to the menu's categories, and the next one would
   * revert a type a scrape corrected (retypeUrl). Loaded per process and shared
   * with clones, like `categories`.
   */
  private urlTypes = new Map<string, string>();

  constructor(connection: ConnectionPool | ConnectionInfo, schema?: Schema) {
    super(connection, schema);
    this.site = {} as Site;
    this.baseUrl = '';
    this.hashUrl = sha1;
  }

  async init(name: string): Promise<Site> {
    if (!this.schema) await this.buildSchema();
    this.site = <Site>(
      (<any>(
        await this.table('site').select({ crawler: '*' }, { where: { name } })
      ))[0]
    );
    if (this.site) {
      this.allows = pathRules(this.site.crawler.allow, this.site.crawler.disallow);
      await this.loadCategories();
      await this.loadUrlTypes();
    }
    return this.site;
  }

  /** The queued urls' types, so a re-queued link cannot revert one. */
  private async loadUrlTypes() {
    this.urlTypes.clear();
    const stored = (await this.table('url').select(
      { hash: true, type: true },
      { where: { site: this.site.id } }
    )) as unknown as { hash: string; type: string }[];
    for (const url of stored) this.urlTypes.set(url.hash, url.type);
  }

  /** The site's stored categories, so a re-referenced one is updated in place. */
  private async loadCategories() {
    const stored = (await this.table('category').select(
      { id: true, url: { fields: ['hash'] } },
      { where: { site: this.site.id } }
    )) as unknown as { id: number; url: { hash: string } }[];
    for (const category of stored) {
      this.categories.set(category.url.hash, Number(category.id));
    }
  }

  clone(): CrawlerDatabase {
    const db = new CrawlerDatabase(this.pool, this.schema);
    db.site = this.site;
    db.hashUrl = this.hashUrl;
    db.categories = this.categories;
    db.urlTypes = this.urlTypes;
    db.allows = this.allows;
    return db;
  }

  async claimUrl(filter?: UrlFilter): Promise<SiteUrl | null> {
    const now = new Date();
    const url: unknown = await this.table('url').claim(
      {
        site: this.site.id,
        ...filter,
        or: [
          { status: UrlStatus.Idle },
          {
            status: UrlStatus.Busy,
            claimedAt_lt: new Date(now.getTime() - STALE_CLAIM_MS),
          },
        ],
      },
      { status: UrlStatus.Busy, claimedAt: now },
      ['-priority']
    );
    return url ? (url as SiteUrl) : null;
  }

  resetUrls(filter?: UrlFilter) {
    return this.table('url').update({ status: 0 }, { site: this.site.id, ...filter });
  }

  /**
   * The absolute, fragment-free form of a url, as it is queued and hashed, or
   * null when it is not a page the crawler could fetch: empty, unparseable, or a
   * scheme like mailto:, tel:, javascript: - or a site's typo'd `ttps://`. Such a
   * link would otherwise sit in the queue as a permanent fetch failure.
   */
  private absolute(href: string): string | null {
    const cleaned = (href ?? '').replace(/#.*/, '').trim();
    if (!cleaned) return null;
    if (/^https?:\/\//i.test(cleaned)) return cleaned;
    try {
      const resolved = new URL(cleaned, this.baseUrl);
      return /^https?:$/i.test(resolved.protocol) ? resolved.href : null;
    } catch {
      return null;
    }
  }

  /**
   * Queues a page; null when `href` is not a fetchable url (see absolute()). A
   * category or product url the crawler's path rules disallow is recorded, so
   * categories keep their place in the tree, but never fetched.
   */
  addUrl(data: string | FieldMap, type: string, fromUrlId: number | null): DynamicRecord | null {
    const href = this.absolute(typeof data === 'string' ? data : <string>data.url);
    if (!href) return null;
    const hash = this.hashUrl(href);
    const url = this.table('url').append({
      url: href,
      site: this.site.id,
      hash,
    });
    if (typeof data !== 'string') {
      for (const key in data) {
        if (key !== 'url') {
          url[key] = data[key];
        }
      }
    }
    // First type wins; retypeUrl is how a type is corrected. A known url still
    // carries its type: the row is inserted first (type is NOT NULL), and an
    // unchanged type is not written over the stored one.
    if (type && !this.urlTypes.has(hash)) this.urlTypes.set(hash, type);
    const known = this.urlTypes.get(hash);
    if (known) url.type = known;
    if ((type === 'category' || type === 'product') && !this.allows(href)) {
      url.status = UrlStatus.Disallowed;
    }
    if (fromUrlId) {
      this.table('url_graph').append({ src: fromUrlId, dst: url });
    }
    return url;
  }

  /**
   * Corrects the type of a url that is already queued, for a page that turned
   * out to carry another record than its url shape promised. The page is not
   * fetched again: scrape it with the right method in the same pass, then retype
   * it so a later run dispatches correctly. The correction sticks - a link
   * queued from another page does not revert it.
   *
   * Pass the record the crawl is holding (`this.siteUrl`), not just its url: the
   * validation after this scrape must ask the questions for the page's real type,
   * not for the guess that queued it.
   */
  retypeUrl(url: SiteUrl | string, type: string) {
    const href = typeof url === 'string' ? this.absolute(url) : url.url;
    if (!href) return null;
    if (typeof url !== 'string') url.type = type;
    const hash = this.hashUrl(href);
    this.urlTypes.set(hash, type);
    return this.table('url').append({ url: href, site: this.site.id, hash, type });
  }

  // Updates status, version and data of the url
  updateUrl(url: SiteUrl) {
    return this.table('url').append({
      id: url.id,
      version: url.version,
      status: url.status,
      data: url.data,
    });
  }

  async getUrl(url: string) {
    const where: Filter = /^\d+$/.test(url)
      ? { id: url }
      : { hash: this.hashUrl(url) };
    const rows = await this.table('url').select({ site: '*' }, { where });
    if (rows.length !== 1) {
      throw new Error(`Url not found: ${url}`);
    }
    return rows[0] as unknown as SiteUrl;
  }

  stats(): string {
    return this.tableList
      .filter((table) => table.recordList.length > 0)
      .map((table) => `${table.name}: ${table.recordList.length}`)
      .join(', ');
  }

  flush() {
    return super
      .flush({
        replaceRecordsIn: PRODUCT_DETAILS,
        replaceRoots: [...this.detailedProducts],
      })
      .then(async (flushed) => {
        this.rememberCategories();
        // one primary per product: the page that now names it wins
        for (const membership of this.primaryCategories.values()) {
          await this.query(
            'update product_category set is_primary = false where product_id = ? and id <> ? and is_primary',
            (membership.product as DynamicRecord).id,
            membership.id
          );
        }
        return flushed;
      })
      .catch((err: any) => {
        throw new Error(`${err?.message ?? err}\nflushing: ${this.dirtySummary()}`);
      });
  }

  /** Keeps the ids this flush assigned, so the next page reuses them. */
  private rememberCategories() {
    for (const record of this.table('category').recordList) {
      const { id, url } = record as unknown as { id?: number; url?: { hash?: string } };
      if (id && url?.hash) this.categories.set(url.hash, Number(id));
    }
  }

  /** The buffered records about to be written, a few labels per table, for flush error messages. */
  private dirtySummary(): string {
    const parts = this.tableList
      .filter((table) => table.recordList.length > 0)
      .map((table) => {
        const labels = table.recordList
          .slice(0, 3)
          .map((record) => label(record))
          .join(', ');
        return `${table.name}: ${table.recordList.length} [${labels}]`;
      });
    return parts.join('; ') || 'nothing';
  }

  clear() {
    super.clear();
    this.urlFetch = null;
    this.observedAt = new Date();
    this.detailedProducts.clear();
    this.primaryCategories.clear();
    this.attributeCount.clear();
    this.groupCount.clear();
    this.groupRecords.clear();
    this.imageCount.clear();
    this.variantCount.clear();
    return this;
  }

  // -- Catalogue --

  addCategory(
    name: string,
    link: string,
    fromUrl: SiteUrl,
    parent: Record | null,
    details: CategoryDetails = {}
  ) {
    const url = this.addUrl(
      { url: new URL(link, fromUrl.url).href, site: fromUrl.site.id },
      'category',
      fromUrl.id
    );
    if (!url) return null;
    const id = this.categories.get(url.hash as string);
    // a trail ending in the page's canonical url names the category itself
    const own = (parent as DynamicRecord | null)?.url === url;
    const category = this.table('category').append({
      ...(id === undefined ? {} : { id }),
      site: this.site.id,
      ...(own ? {} : { parent }),
      url,
      name: trimTitle(name),
    });
    if (details.description?.trim()) category.description = details.description.trim();
    if (details.sortOrder !== undefined) category.sortOrder = details.sortOrder;
    if (details.image) {
      const image = this.addUrl(details.image, 'image', null);
      if (image) category.image = image;
    }
    return category;
  }

  /**
   * Saves a breadcrumb trail as a chain of categories and returns the deepest
   * one (null when no crumb qualifies). Crumbs without a link, the site's home
   * page and the current page itself are skipped.
   */
  addCategoryPath(crumbs: Breadcrumb[], fromUrl: SiteUrl): DynamicRecord | null {
    const current = new URL(fromUrl.url);
    // the page's own crumb, also when the page carries extra query (?variant=, ?page=)
    const isCurrent = (url: URL) =>
      url.origin === current.origin &&
      url.pathname === current.pathname &&
      [...url.searchParams].every(([key, value]) => current.searchParams.getAll(key).includes(value));
    const seen = new Set<string>();
    let parent: DynamicRecord | null = null;
    for (const crumb of crumbs) {
      if (!crumb.url) continue;
      const url = new URL(crumb.url, fromUrl.url);
      url.hash = '';
      if (url.pathname === '/' || isCurrent(url) || seen.has(url.href)) continue;
      seen.add(url.href);
      parent = this.addCategory(crumb.name, url.href, fromUrl, parent);
    }
    return parent;
  }

  /** Saves a navigation menu as a category tree. */
  addCategoryTree(
    nodes: CategoryNode[],
    fromUrl: SiteUrl,
    parent: DynamicRecord | null = null
  ) {
    for (const node of nodes) {
      const category = node.url
        ? this.addCategory(node.name, node.url, fromUrl, parent)
        : parent;
      this.addCategoryTree(node.children ?? [], fromUrl, category);
    }
  }

  /**
   * Upserts a product by its site-wide code; when the site exposes no stable
   * code, use the path of the product's canonical url. Pass `detailed` when
   * scraping the product's own page: its attributes and assets are then
   * replaced on flush instead of merged, and `category` becomes its primary
   * category. Without `detailed`, `category` adds a plain membership.
   */
  addProduct(
    input: ProductInput,
    options: { category?: Record | null; position?: number; detailed?: boolean } = {}
  ) {
    const { brand, name, structuredData, ...fields } = input;
    const product = this.table('product').append({
      ...defined(fields),
      site: this.site.id,
      code: input.code.trim(),
      status: 'active',
      lastSeenAt: this.observedAt,
    });
    if (name !== undefined) {
      product.name = trimTitle(name);
    }
    if (brand) {
      product.brand = this.table('brand').append({ name: brand.trim() });
    }
    if (structuredData !== undefined) {
      product.structuredData = structuredData as Value;
    }
    if (options.category) {
      const membership = this.table('product_category').append({
        product,
        category: options.category,
        ...(options.position === undefined ? {} : { position: options.position }),
        ...(options.detailed ? { isPrimary: true } : {}),
      });
      if (options.detailed) this.primaryCategories.set(product, membership);
    }
    if (options.detailed) {
      this.detailedProducts.add(product);
    }
    return product;
  }

  /**
   * Upserts a variant and records a price observation when the input carries
   * price or availability. `values` are the attribute values defining it (from
   * addAttribute on the same product), at most one per attribute.
   */
  addVariant(product: Record, input: VariantInput = {}, values: DynamicRecord[] = []) {
    const attributes = new Set<DynamicRecord>();
    for (const value of values) {
      const attribute = value.attribute as DynamicRecord;
      if (attribute.product !== product) {
        throw new Error(`Attribute value ${value.value} belongs to another product`);
      }
      if (attributes.has(attribute)) {
        throw new Error(`Variant has two values for ${attribute.name}`);
      }
      attributes.add(attribute);
    }
    const variant = this.table('product_variant').append({
      ...defined(input),
      product,
      code: input.code ?? '',
      sortOrder: nextPosition(this.variantCount, product),
      lastSeenAt: this.observedAt,
    });
    for (const attributeValue of values) {
      this.table('product_variant_value').append({ variant, attributeValue });
    }
    if (PRICE_FIELDS.some((name) => input[name] !== undefined)) {
      const price = this.table('variant_price').append({
        variant,
        urlFetch: this.urlFetch,
        observedAt: this.observedAt,
        currency: this.site.currency,
      });
      for (const name of PRICE_FIELDS) {
        if (input[name] !== undefined) {
          price[name] = input[name];
        }
      }
    }
    return variant;
  }

  /**
   * Adds a spec ("Material: Leather") or a choice ("Spice: Mild / Hot +1.50").
   * `groupName` '' (the default) is the root group: its attributes render
   * ungrouped. The group row is created once per product and buffer cycle,
   * keeping a stable sort_order of first use.
   */
  addAttribute(product: Record, input: AttributeInput) {
    if (!Array.isArray(input.values)) {
      throw new Error(`Attribute "${input.name}" values must be an array of strings or { value: string } objects`);
    }
    const entries = Array.from(input.values, (entry, index) => {
      const fields = typeof entry === 'string' ? { value: entry } : entry;
      if (!fields || typeof fields.value !== 'string') {
        throw new Error(
          `Attribute "${input.name}" values[${index}] must be a string or { value: string }; ` +
          `received ${JSON.stringify(entry) ?? 'undefined'}. Check the source JSON shape and the values mapping.`
        );
      }
      return fields;
    });
    const groupName = input.groupName ?? '';
    let group = this.groupRecords.get(product)?.get(groupName);
    if (!group) {
      group = this.table('product_attribute_group').append({
        product,
        name: groupName,
        sortOrder: nextPosition(this.groupCount, product),
      });
      let byName = this.groupRecords.get(product);
      if (!byName) this.groupRecords.set(product, (byName = new Map()));
      byName.set(groupName, group);
    }
    const attribute = this.table('product_attribute').append({
      product,
      group,
      name: input.name.trim(),
      sortOrder: nextPosition(this.attributeCount, product),
    });
    if (input.minSelect !== undefined) attribute.minSelect = input.minSelect;
    if (input.maxSelect !== undefined) attribute.maxSelect = input.maxSelect;
    if (input.allowQuantity !== undefined) attribute.allowQuantity = input.allowQuantity;
    const values = entries.map(({ value, ...fields }, sortOrder) => {
      return this.table('product_attribute_value').append({
        ...defined(fields),
        attribute,
        value: value.trim(),
        sortOrder,
      });
    });
    return { attribute, values };
  }

  /** Adds spec pairs ("Material: Concrete") as single-valued attributes. */
  addSpecs(product: Record, pairs: SpecPair[], groupName?: string) {
    for (const { name, value } of pairs) {
      this.addAttribute(product, { groupName, name, values: [value] });
    }
  }

  /**
   * Saves extracted product data: the product, its variant axes, variants
   * (linked to their axis values) and images. `code` overrides the extracted
   * code, which is required when the data has none.
   */
  addProductData(
    data: ProductData,
    options: { code?: string; category?: Record | null; detailed?: boolean } = {}
  ) {
    const code = options.code ?? data.product.code;
    if (!code) {
      throw new Error(`Product has no code: ${data.product.name}`);
    }
    const product = this.addProduct({ ...data.product, code }, options);
    const axes = new Map<string, Map<string, DynamicRecord>>();
    for (const input of data.attributes) {
      const { values } = this.addAttribute(product, input);
      axes.set(input.name, new Map(values.map((value) => [value.value, value])));
    }
    for (const { values = {}, ...input } of data.variants) {
      const records = Object.entries(values)
        .map(([name, value]) => axes.get(name)?.get(value.trim()))
        .filter((record): record is DynamicRecord => !!record);
      this.addVariant(product, input, records);
    }
    for (const image of data.images) {
      this.addProductImage(product, image);
    }
    return product;
  }

  addProductUrl(product: Record, link: string | number, fromUrlId: number | null) {
    const url = typeof link === 'number' ? link : this.addUrl(link, 'product', fromUrlId);
    if (!url) return null;
    return this.table('product_url').append({ product, url });
  }

  /**
   * Adds an image of the whole product, or of the given variants only. `pure`
   * says whether it shows the product alone; leave it out when unsure.
   */
  addProductImage(
    product: Record,
    link: string,
    role = 'gallery',
    variants: DynamicRecord[] = [],
    pure?: boolean
  ) {
    for (const variant of variants) {
      if (variant.product !== product) {
        throw new Error(`Variant ${variant.code} belongs to another product`);
      }
    }
    const url = this.addUrl(link, 'image', null);
    if (!url) return null;
    const image = this.table('product_image').append({
      product,
      url,
      role,
      position: nextPosition(this.imageCount, product),
      ...(pure === undefined ? {} : { pure }),
    });
    for (const variant of variants) {
      this.table('product_image_variant').append({ image, variant });
    }
    return image;
  }

  addProductAsset(product: Record, kind: string, name: string, value: string) {
    return this.table('product_asset').append({
      product,
      kind,
      name: name.trim(),
      value,
    });
  }

  /** Marks the products found at a url as no longer on the site. */
  markProductsGone(urlId: number) {
    return this.query(
      `update product set status = 'gone'
       where id in (select product_id from product_url where url_id = ?)`,
      urlId
    );
  }
}

/** Drops undefined fields, which sqlex refuses to assign. */
function defined<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}

/** Identifies a buffered record in error messages by its most meaningful field. */
function label(record: Record): string {
  return String(
    record.get('code') ?? record.get('url') ?? record.get('name') ?? record.get('value') ?? record.get('id') ?? '(record)'
  );
}

function nextPosition(counts: Map<Record, number>, product: Record) {
  const position = counts.get(product) ?? 0;
  counts.set(product, position + 1);
  return position;
}
