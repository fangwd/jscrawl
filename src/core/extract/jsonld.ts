import type { XDocument } from 'gumbo-html';
import type {
  AttributeInput,
  Availability,
  ProductInput,
  VariantInput,
} from '../database';

export type JsonLdNode = { '@type'?: string | string[]; [key: string]: any };

export interface ProductData {
  product: Omit<ProductInput, 'code'> & { code?: string };
  /** Variant axes (ProductGroup.variesBy), named like "Color". */
  attributes: AttributeInput[];
  /** `values` maps an axis name to this variant's value. */
  variants: (VariantInput & { values?: { [attribute: string]: string } })[];
  images: string[];
}

/** Every JSON-LD node on the page; arrays and @graph are flattened. */
export function jsonLd(doc: XDocument): JsonLdNode[] {
  const nodes: JsonLdNode[] = [];
  const collect = (data: unknown) => {
    if (Array.isArray(data)) {
      data.forEach(collect);
    } else if (data && typeof data === 'object') {
      const node = data as JsonLdNode;
      if (node['@graph']) collect(node['@graph']);
      if (node['@type']) nodes.push(node);
    }
  };
  for (const script of doc.find('script[type="application/ld+json"]')) {
    try {
      collect(JSON.parse(script.textContent));
    } catch {
      // malformed blocks are common; skip them
    }
  }
  return nodes;
}

export function isType(node: JsonLdNode, type: string) {
  const types = node['@type'];
  return Array.isArray(types) ? types.includes(type) : types === type;
}

export function findType(nodes: JsonLdNode[], type: string) {
  return nodes.filter((node) => isType(node, type));
}

/**
 * The page's main Product or ProductGroup, with other nodes describing the
 * same product merged in (sites often publish it more than once).
 */
export function productFromJsonLd(nodes: JsonLdNode[]): ProductData | null {
  const products = nodes.filter(
    (node) => isType(node, 'Product') || isType(node, 'ProductGroup')
  );
  if (products.length === 0) return null;

  const key = productKey(products[0]);
  const node: JsonLdNode = {};
  for (const other of products) {
    if (other === products[0] || (key && productKey(other) === key)) {
      for (const name in other) {
        node[name] ??= other[name];
      }
    }
  }

  const rating = node.aggregateRating;
  const data: ProductData = {
    product: {
      code: text(node.productGroupID ?? node.productID ?? node.sku),
      name: text(node.name),
      description: text(node.description),
      brand: text(node.brand?.name ?? node.brand),
      ratingValue: number(rating?.ratingValue),
      reviewCount: number(rating?.reviewCount ?? rating?.ratingCount),
      structuredData: node,
    },
    attributes: [],
    variants: [],
    images: images(node.image),
  };

  const variants = list(node.hasVariant);
  if (variants.length === 0) {
    data.variants.push(variantOf(node, ''));
    data.attributes.push(...priceAttributes(node));
    return data;
  }

  const axes = list(node.variesBy).map((axis) =>
    String(axis).replace(/^https?:\/\/schema\.org\//, '')
  );
  for (const variant of variants) {
    const values: { [attribute: string]: string } = {};
    for (const axis of axes) {
      const value = text(variant[axis]?.name ?? variant[axis]);
      if (value) values[capitalize(axis)] = value;
    }
    const code = text(variant.sku ?? variant.productID ?? variant['@id']) ?? '';
    data.variants.push({ ...variantOf(variant, code), name: text(variant.name), values });
    for (const image of images(variant.image)) {
      if (!data.images.includes(image)) data.images.push(image);
    }
  }
  for (const axis of axes) {
    const name = capitalize(axis);
    const values = [
      ...new Set(data.variants.map((v) => v.values?.[name]).filter((v): v is string => !!v)),
    ];
    if (values.length > 0) data.attributes.push({ name, values });
  }
  data.attributes.push(...priceAttributes(node));
  return data;
}

const AVAILABILITY: { [schemaOrg: string]: Availability } = {
  InStock: 'in_stock',
  InStoreOnly: 'in_stock',
  OnlineOnly: 'in_stock',
  OutOfStock: 'out_of_stock',
  SoldOut: 'out_of_stock',
  LimitedAvailability: 'limited',
  PreOrder: 'preorder',
  PreSale: 'preorder',
  BackOrder: 'backorder',
  Discontinued: 'discontinued',
};

function variantOf(node: JsonLdNode, code: string): VariantInput {
  const offer = list(node.offers).flatMap((o) => (isType(o, 'AggregateOffer') && o.offers ? list(o.offers) : [o]))[0];
  const variant: VariantInput = {
    code,
    sku: text(node.sku),
    gtin: text(node.gtin ?? node.gtin13 ?? node.gtin14 ?? node.gtin12 ?? node.gtin8),
    mpn: text(node.mpn),
  };
  if (offer) {
    const specs = list(offer.priceSpecification);
    const listPrice = specs.find((s) => /ListPrice|StrikethroughPrice/.test(String(s.priceType)));
    const unitPrice = specs.find((s) => s.referenceQuantity);
    variant.price = number(
      offer.price ?? offer.lowPrice ?? specs.find((s) => !s.priceType && !s.referenceQuantity)?.price
    );
    variant.compareAtPrice = number(listPrice?.price);
    variant.unitPrice = number(unitPrice?.price);
    variant.unit = text(unitPrice?.referenceQuantity?.unitText ?? unitPrice?.referenceQuantity?.unitCode);
    variant.availability = AVAILABILITY[String(offer.availability ?? '').replace(/^.*\//, '')];
  }
  return variant;
}

/**
 * The labelled unit prices an offer quotes - "Price per square meter", "Price
 * per linear metre" - as attributes of a Pricing group. A variant has one
 * unitPrice column, so an offer quoting several would lose all but the first;
 * the unnamed specification is the variant's own unit price and stays there.
 */
function priceAttributes(node: JsonLdNode): AttributeInput[] {
  const prices = new Map<string, string>();
  for (const offer of list(node.offers)) {
    for (const spec of list(offer?.priceSpecification)) {
      const name = text(spec?.name);
      const price = number(spec?.price);
      if (!name || price === undefined || prices.has(name)) continue;
      const currency = text(spec?.priceCurrency ?? offer?.priceCurrency);
      const unit = text(spec?.referenceQuantity?.unitText ?? spec?.referenceQuantity?.unitCode);
      prices.set(name, `${price}${currency ? ` ${currency}` : ''}${unit ? ` per ${unit}` : ''}`);
    }
  }
  return [...prices].map(([name, value]) => ({ groupName: 'Pricing', name, values: [value] }));
}

function productKey(node: JsonLdNode): string | undefined {
  return text(node.productGroupID ?? node.productID ?? node.sku ?? node.url);
}

function images(value: unknown): string[] {
  return list(value)
    .map((image) => (typeof image === 'string' ? image : image?.contentUrl ?? image?.url))
    .filter((url): url is string => typeof url === 'string' && url.length > 0);
}

function list(value: unknown): any[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function number(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? parseFloat(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function capitalize(name: string) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
