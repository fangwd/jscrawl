// Shop components drawn from the crawled sites' home, category and product
// pages, written the way Nova's shop library is (nova/scripts/shop-components)
// so intake is a move into library.ts. Props marked `reg` are registry
// properties; library.ts's REGISTRY holds the existing ones, NEW_REGISTRY the
// ones these components add.
import {
  BREAKPOINT_PROP,
  box,
  CONTENT_BLOCK,
  empty,
  HEADING,
  type Json,
  label,
  MEDIA,
  PARAGRAPH,
  PLACEHOLDER_IMAGE,
  prop,
  rich,
  staticAttrs,
  text,
  use,
} from '../../nova/scripts/shop-components/kit';
import { REGISTRY } from '../../nova/scripts/shop-components/library';

const ICON = 'bb57d385-17ef-487a-8d36-3c8534d8118a';
const STAR_RATING = 'el-star-rating';

// ── Registry ────────────────────────────────────────────────────────────────

export const NEW_REGISTRY = [
  {
    memoryKey: 'productImageAlt',
    propType: 'image',
    initial: PLACEHOLDER_IMAGE,
    description: "The product's second photo, shown while the card is hovered.",
    displayName: 'Second image',
    userFacing: true,
    sortOrder: 45,
    shop: 'media.1.url',
  },
] as const;

const ALL_REGISTRY = [...REGISTRY, ...NEW_REGISTRY];

const shopList = (source: string, limit = 8, sort = 'featured') =>
  JSON.stringify({ source, sort, limit });

/** A prop backed by registry entry `key`, as library.ts declares them. */
const reg = (key: string, defaultValue?: unknown): Json => {
  const entry = ALL_REGISTRY.find((e) => e.memoryKey === key);
  if (!entry) throw new Error(`No registry entry ${key}`);
  return {
    reg: key,
    name: key,
    type: entry.propType,
    defaultValue: defaultValue ?? entry.initial,
    displayName: entry.displayName,
    propertyCategory: entry.propType === 'shopList' ? 'Settings' : 'Content',
    userFacing: entry.userFacing && !('shop' in entry && entry.shop),
    ...('shop' in entry && entry.shop ? { shop: entry.shop } : {}),
  };
};

/** An authored prop on an existing registry id, so it reaches embedded elements. */
const authored = (
  id: number,
  name: string,
  type: string,
  defaultValue: unknown,
  displayName: string,
  propertyCategory = 'Content',
): Json => ({
  id,
  name,
  type,
  defaultValue,
  displayName,
  propertyCategory,
  userFacing: true,
});

const ITEM_LINK = {
  id: 2059,
  name: 'itemLink',
  type: 'link',
  defaultValue: '',
  displayName: 'Link',
  propertyCategory: 'Settings',
  userFacing: false,
  shop: 'url',
};
const HEADING_TEXT = (value: string) =>
  authored(53, 'headingText', 'richText', rich(value), 'Text');
const LINK_LABEL = (value: string) =>
  authored(83, 'buttonLabel', 'string', value, 'Link label');
const LINK_HREF = authored(84, 'buttonLink', 'link', '', 'Link', 'Settings');

/** A repeat's items: count rows, each with its own prop overrides. */
const items = (rows: Record<string, unknown>[]) => ({
  id: 460,
  name: 'items',
  type: 'array',
  defaultValue: rows.map((overrides) => ({
    breakpoint: '',
    $propOverrides: overrides,
  })),
  userFacing: false,
});

// ── Theme classes ───────────────────────────────────────────────────────────

const s = (value: string) => ({ mode: 'static', value });
const t = (value: string) => ({ mode: 'token', value });

export const CLASSES: Record<string, Json> = {
  // Product card media: a well holding the photo, the hover photo and a badge.
  'shop-card-media': {
    style: {
      position: s('relative'),
      overflow: s('hidden'),
      borderRadius: t('radius.medium'),
      backgroundColor: t('scheme.background-secondary'),
    },
    css: `& > [data-card-alt] {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity 0.4s ease;
}
a:hover > & > [data-card-alt],
a:focus-visible > & > [data-card-alt] {
  opacity: 1;
}
& > [data-card-alt] > * {
  height: 100%;
}
@media (prefers-reduced-motion: reduce) {
  & > [data-card-alt] {
    transition: none;
  }
}`,
  },
  'shop-card-media-contain': {
    style: { padding: t('spacing.6') },
    css: `& img {
  object-fit: contain;
  mix-blend-mode: multiply;
}`,
  },
  'shop-badge': {
    style: {
      position: s('absolute'),
      top: t('spacing.3'),
      left: t('spacing.3'),
      zIndex: s('1'),
      display: s('inline-flex'),
      paddingTop: t('spacing.1'),
      paddingBottom: t('spacing.1'),
      paddingLeft: t('spacing.2.5'),
      paddingRight: t('spacing.2.5'),
      borderRadius: t('radius.small'),
      backgroundColor: t('scheme.accent'),
      color: t('scheme.background'),
      fontSize: t('text.tiny-size'),
      fontWeight: t('font.weight-semibold'),
      letterSpacing: s('0.04em'),
      textTransform: s('uppercase'),
    },
  },
  'shop-visually-hidden': {
    style: {
      position: s('absolute'),
      width: s('1px'),
      height: s('1px'),
      overflow: s('hidden'),
      clipPath: s('inset(50%)'),
      whiteSpace: s('nowrap'),
    },
  },
  // A product card that buys in place: a commerce root, not a link.
  'shop-quick-card': {
    style: {
      display: s('flex'),
      flexDirection: s('column'),
      gap: t('gap.element-small'),
      height: s('100%'),
    },
    css: `& > .shop-quick-buy {
  margin-top: auto;
}`,
  },
  'shop-quick-buy': {
    style: { display: s('grid'), gap: t('gap.element-tiny') },
    css: `& select {
  width: 100%;
}
& > button {
  justify-content: center;
}
& > button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}`,
  },
  'shop-compact-card': {
    style: {
      display: s('grid'),
      gridTemplateColumns: s('5rem minmax(0, 1fr) auto'),
      alignItems: s('center'),
      gap: t('gap.element-horizontal-small'),
      padding: t('spacing.3'),
      borderRadius: t('radius.medium'),
      backgroundColor: t('scheme.background'),
    },
  },
  // A row of cards that scrolls sideways, the next card peeking in.
  'shop-track': {
    style: {
      display: s('grid'),
      gridAutoFlow: s('column'),
      gridAutoColumns: s('calc((100% - 3 * var(--gap-grid-column-4)) / 4.25)'),
      gap: t('gap.grid-column-4'),
      overflowX: s('auto'),
      scrollSnapType: s('x mandatory'),
      scrollbarWidth: s('thin'),
      paddingBottom: t('spacing.4'),
    },
    css: `& > * {
  scroll-snap-align: start;
}`,
    breakpointStyles: {
      tablet: { gridAutoColumns: s('calc((100% - var(--gap-grid-column-4)) / 2.3)') },
      mobile: { gridAutoColumns: s('80%') },
    },
  },
  'shop-heading-row': {
    style: {
      display: s('flex'),
      alignItems: s('end'),
      justifyContent: s('space-between'),
      gap: t('gap.element-horizontal-large'),
    },
  },
  // Category tiles: a photo with a label on a gradient at its foot.
  'shop-tile': {
    style: {
      position: s('relative'),
      display: s('block'),
      overflow: s('hidden'),
      borderRadius: t('radius.medium'),
      color: s('#fff'),
      textDecoration: s('none'),
    },
    css: `& img {
  transition: transform 0.6s ease;
}
&:hover img {
  transform: scale(1.04);
}
@media (prefers-reduced-motion: reduce) {
  & img {
    transition: none;
  }
}`,
  },
  'shop-tile-label': {
    style: {
      position: s('absolute'),
      left: s('0'),
      right: s('0'),
      bottom: s('0'),
      display: s('flex'),
      flexDirection: s('column'),
      gap: t('gap.element-tiny'),
      padding: t('spacing.6'),
      paddingTop: t('spacing.16'),
      backgroundImage: s('linear-gradient(to top, rgb(0 0 0 / 0.55), transparent)'),
    },
    css: `& h3, & span {
  color: inherit;
}`,
  },
  // Benefit strip: columns split by hairlines, ruled above and below.
  'shop-usp-strip': {
    style: {
      display: s('grid'),
      gridTemplateColumns: s('repeat(4, minmax(0, 1fr))'),
      borderTop: s('1px solid var(--scheme-border)'),
      borderBottom: s('1px solid var(--scheme-border)'),
    },
    css: `& > * + * {
  border-left: 1px solid var(--scheme-border);
}`,
    breakpointStyles: {
      tablet: { gridTemplateColumns: s('repeat(2, minmax(0, 1fr))') },
      mobile: { gridTemplateColumns: s('minmax(0, 1fr)') },
    },
  },
  'shop-usp': {
    style: {
      display: s('flex'),
      flexDirection: s('column'),
      alignItems: s('center'),
      gap: t('gap.element-tiny'),
      padding: t('spacing.6'),
      textAlign: s('center'),
    },
  },
  // Category banner: the header on a photo, darkened for its text.
  'shop-banner': {
    style: {
      position: s('relative'),
      display: s('grid'),
      alignItems: s('end'),
      minHeight: s('22rem'),
      overflow: s('hidden'),
      borderRadius: t('radius.large'),
      color: s('#fff'),
    },
    css: `& > [data-banner-image] {
  position: absolute;
  inset: 0;
}
& > [data-banner-image] > * {
  height: 100%;
}
& > [data-banner-image]::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(to top, rgb(0 0 0 / 0.6), rgb(0 0 0 / 0.1));
}
& h1, & p, & a {
  color: inherit;
}`,
  },
  'shop-banner-content': {
    style: {
      position: s('relative'),
      display: s('flex'),
      flexDirection: s('column'),
      gap: t('gap.element-small'),
      maxWidth: s('40rem'),
      padding: t('spacing.10'),
    },
  },
  'shop-breadcrumb': {
    style: {
      display: s('flex'),
      gap: t('gap.element-horizontal-tiny'),
      fontSize: t('text.small-size'),
    },
    css: `& > a {
  text-decoration: none;
  opacity: 0.85;
}`,
  },
  'shop-chips': {
    style: {
      display: s('flex'),
      flexWrap: s('wrap'),
      gap: t('gap.element-horizontal-small'),
    },
  },
  'shop-chip': {
    style: {
      display: s('inline-flex'),
      alignItems: s('center'),
      paddingTop: t('spacing.2'),
      paddingBottom: t('spacing.2'),
      paddingLeft: t('spacing.4'),
      paddingRight: t('spacing.4'),
      border: s('1px solid var(--scheme-border)'),
      borderRadius: s('999px'),
      color: t('scheme.text'),
      fontSize: t('text.small-size'),
      textDecoration: s('none'),
      whiteSpace: s('nowrap'),
    },
    css: `&:hover {
  border-color: var(--scheme-heading);
}`,
  },
  // Sticky buy bar: pinned to the foot of the viewport on a product page.
  'shop-buy-bar': {
    style: {
      position: s('sticky'),
      bottom: s('0'),
      zIndex: s('40'),
      backgroundColor: t('scheme.background'),
      borderTop: s('1px solid var(--scheme-border)'),
      boxShadow: s('0 -8px 24px rgb(0 0 0 / 0.06)'),
    },
  },
  'shop-buy-bar-inner': {
    style: {
      display: s('grid'),
      gridTemplateColumns: s('3.5rem minmax(0, 1fr) auto'),
      alignItems: s('center'),
      gap: t('gap.element-horizontal-medium'),
      paddingTop: t('spacing.3'),
      paddingBottom: t('spacing.3'),
    },
    breakpointStyles: {
      mobile: { gridTemplateColumns: s('minmax(0, 1fr) auto') },
    },
    css: `@media (max-width: 767px) {
  & > :first-child {
    display: none;
  }
}`,
  },
  // Reviews: the score and its histogram beside the reviews.
  'shop-reviews': {
    style: {
      display: s('grid'),
      gridTemplateColumns: s('minmax(0, 1fr) minmax(0, 2.4fr)'),
      gap: t('gap.grid-column-2'),
      alignItems: s('start'),
    },
    breakpointStyles: { tablet: { gridTemplateColumns: s('minmax(0, 1fr)') } },
  },
  'shop-score': {
    style: {
      fontFamily: t('font.family-heading'),
      fontSize: t('text.display-small-size'),
      lineHeight: s('1'),
      fontWeight: t('font.weight-bold'),
      color: t('scheme.heading'),
    },
  },
  'shop-histogram-row': {
    style: {
      display: s('grid'),
      gridTemplateColumns: s('2.5rem minmax(0, 1fr) 2.5rem'),
      alignItems: s('center'),
      gap: t('gap.element-horizontal-small'),
      fontSize: t('text.small-size'),
    },
  },
  'shop-histogram-bar': {
    style: {
      height: s('0.5rem'),
      overflow: s('hidden'),
      borderRadius: s('999px'),
      backgroundColor: t('scheme.background-secondary'),
    },
    css: `& > * {
  height: 100%;
  background-color: var(--scheme-heading);
}`,
  },
  'shop-review-card': {
    style: {
      display: s('flex'),
      flexDirection: s('column'),
      gap: t('gap.element-small'),
      padding: t('spacing.6'),
      border: s('1px solid var(--scheme-border)'),
      borderRadius: t('radius.medium'),
    },
  },
  // Featured product: a card floating on a photo.
  'shop-feature': {
    style: {
      position: s('relative'),
      display: s('grid'),
      alignItems: s('center'),
      minHeight: s('36rem'),
      overflow: s('hidden'),
      borderRadius: t('radius.large'),
    },
    css: `& > [data-feature-image] {
  position: absolute;
  inset: 0;
}
& > [data-feature-image] > * {
  height: 100%;
}`,
  },
  'shop-feature-card': {
    style: {
      position: s('relative'),
      display: s('flex'),
      flexDirection: s('column'),
      gap: t('gap.element-medium'),
      width: s('min(28rem, calc(100% - 2 * var(--spacing-6)))'),
      margin: t('spacing.10'),
      padding: t('spacing.8'),
      borderRadius: t('radius.large'),
      backgroundColor: t('scheme.background'),
    },
    breakpointStyles: { mobile: { margin: t('spacing.6') } },
  },
};

// ── Shared pieces ───────────────────────────────────────────────────────────

const media = (imageProp: string, aspectRatio: string, extra: Json = {}) =>
  use(MEDIA, {
    imageSource: prop(imageProp),
    aspectRatio,
    mediaType: 'Image',
    mediaRadius: 'None',
    ...extra,
  });

/** "Was $X" shown only while on sale; the struck price beside the price. */
const PRICE_ROW = (priceClass: string) =>
  box('div', ['row', 'gap-element-horizontal-small'], {
    Price: text('span', prop('productPrice'), [priceClass]),
    'Compare Price': text(
      's',
      prop('productComparePrice'),
      ['text-style-small', 'shop-compare'],
      { hidable: true, visible: true },
    ),
  });

/** A "Sale" badge over the photo; it holds the was price, for screen
 *  readers, so it hides with it when the product isn't on sale. */
const SALE_BADGE = box(
  'span',
  ['shop-badge'],
  {
    Label: text('span', 'Sale'),
    'Was Price': text('span', prop('productComparePrice'), [
      'shop-visually-hidden',
    ]),
  },
  { hidable: true, visible: true },
);

const productRoot = {
  'data-commerce-product': { prop: 'productSlug' },
} as const;

const sectionShell = (children: Record<string, Json>) =>
  box('div', ['container'], {
    Stack: box('div', ['stack', 'gap-section-content'], children),
  });

const section = (def: {
  id: string;
  name: string;
  description: string;
  props: Json[];
  children: Record<string, Json>;
  attrs?: Record<string, string | { prop: string }>;
  classNames?: string[];
}): Json => ({
  id: def.id,
  name: def.name,
  description: def.description,
  element: 'section',
  componentLevel: 'section',
  category: 'shop',
  tags: ['shop'],
  props: [BREAKPOINT_PROP, ...def.props],
  classNames: def.classNames ?? ['section', 'scheme-1'],
  ...(def.attrs ? { attributes: staticAttrs(def.attrs) } : {}),
  children: (def.children.Container
    ? box('div', [], def.children)
    : box('div', [], { Container: sectionShell(def.children) })
  ).children,
});

const repeatList = (def: {
  id: string;
  name: string;
  description: string;
  classNames: string[];
  itemComponentId: string;
  transferKey: string;
  rows: Record<string, unknown>[];
  list?: string;
}): Json => ({
  id: def.id,
  name: def.name,
  description: def.description,
  element: 'div',
  componentLevel: 'content',
  tags: ['shop'],
  props: [
    items(def.rows),
    BREAKPOINT_PROP,
    ...(def.list ? [reg('shopList', def.list)] : []),
  ],
  classNames: def.classNames,
  children: {},
  repeat: {
    itemComponentId: def.itemComponentId,
    propName: 'items',
    propBindings: {},
    listConfig: { defaultCount: def.rows.length, min: 1 },
    transferKey: def.transferKey,
  },
});

const blank = (count: number) => Array.from({ length: count }, () => ({}));

/** A heading on the left and a text link on the right. */
const headingRow = (headingTag = 'H2') =>
  box('div', ['shop-heading-row'], {
    Heading: use(HEADING, {
      headingText: prop('headingText'),
      headingTag,
      headingSize: 'H3',
      maxWidth: 'None',
    }),
    Link: text(
      'a',
      prop('buttonLabel'),
      ['text-style-regular', 'text-weight-strong', 'text-underline'],
      { attrs: { href: { prop: 'buttonLink' } }, hidable: true, visible: true },
    ),
  });

// ── Product cards ───────────────────────────────────────────────────────────

const PRODUCT_CARD_HOVER: Json = {
  id: 'ct-shop-product-card-hover',
  name: 'Product Card • Hover Image',
  description:
    "A shop product as a card linking to its page: its photo, swapped for its second photo on hover, a Sale badge while it's on sale, name, short description, price and was price.",
  element: 'a',
  componentLevel: 'content',
  tags: ['shop'],
  props: [
    BREAKPOINT_PROP,
    ITEM_LINK,
    reg('productName'),
    reg('productSummary'),
    reg('productPrice'),
    reg('productComparePrice'),
    reg('productImage'),
    reg('productImageAlt'),
  ],
  attributes: { href: { mode: 'prop', value: 'itemLink' } },
  classNames: ['stack', 'gap-element-small', 'shop-card-link'],
  children: {
    Media: {
      ...box('div', ['shop-card-media'], {
        Badge: SALE_BADGE,
        Image: media('productImage', 'Portrait'),
        'Hover Image': box(
          'div',
          [],
          { Image: media('productImageAlt', 'Portrait') },
          { attrs: { 'data-card-alt': '', 'aria-hidden': 'true' }, hidable: true, visible: true },
        ),
      }),
      order: 1,
    },
    Info: {
      ...box('div', ['stack', 'gap-element-tiny'], {
        Heading: use(HEADING, {
          headingText: prop('productName'),
          headingSize: 'H6',
          headingTag: 'H3',
          maxWidth: 'None',
        }),
        Summary: use(
          PARAGRAPH,
          {
            paragraphText: prop('productSummary'),
            paragraphSize: 'Small',
            textTruncate: '1 Line',
            maxWidth: 'None',
          },
          { hidable: true, visible: true },
        ),
        Prices: PRICE_ROW('text-style-regular'),
      }),
      order: 2,
    },
  },
};

const PRODUCT_CARD_QUICK_ADD: Json = {
  id: 'ct-shop-product-card-quick-add',
  name: 'Product Card • Quick Add',
  description:
    'A shop product as a card that buys in place: its photo on a soft well, name and price linking to its page, a short description, a picker per option and an add to cart button.',
  element: 'article',
  componentLevel: 'content',
  tags: ['shop'],
  props: [
    BREAKPOINT_PROP,
    ITEM_LINK,
    reg('productName'),
    reg('productSummary'),
    reg('productPrice'),
    reg('productComparePrice'),
    reg('productImage'),
    reg('productSlug'),
    label('addLabel', 'Add button', 'Add to cart'),
  ],
  attributes: staticAttrs(productRoot),
  classNames: ['shop-quick-card'],
  children: {
    Link: {
      ...box(
        'a',
        ['stack', 'gap-element-small', 'shop-card-link'],
        {
          Media: box('div', ['shop-card-media', 'shop-card-media-contain'], {
            Badge: SALE_BADGE,
            Image: media('productImage', 'Square', { imageFit: 'Contain' }),
          }),
          Heading: use(HEADING, {
            headingText: prop('productName'),
            headingSize: 'H6',
            headingTag: 'H3',
            maxWidth: 'None',
          }),
        },
        { attrs: { href: { prop: 'itemLink' } } },
      ),
      order: 1,
    },
    Prices: { ...PRICE_ROW('heading-style-h6'), order: 2 },
    Summary: {
      ...use(
        PARAGRAPH,
        {
          paragraphText: prop('productSummary'),
          paragraphSize: 'Small',
          textTruncate: '2 Lines',
          maxWidth: 'None',
        },
        { hidable: true, visible: true },
      ),
      order: 3,
    },
    Buy: {
      ...box('div', ['shop-quick-buy'], {
        Options: box(
          'div',
          ['stack', 'gap-element-tiny'],
          {
            Axis: box(
              'label',
              [],
              {
                Name: text('span', 'Option', ['shop-visually-hidden'], {
                  attrs: { 'data-commerce-axis-name': '' },
                }),
                Select: box(
                  'select',
                  ['input'],
                  { Value: text('option', 'Choose an option') },
                  { attrs: { 'data-commerce-axis-select': '' } },
                ),
              },
              { attrs: { 'data-commerce-axis': '' } },
            ),
          },
          { attrs: { 'data-commerce-axes': '' } },
        ),
        Add: text('button', prop('addLabel'), ['button', 'button-small'], {
          attrs: { type: 'button', 'data-commerce-add': '' },
        }),
      }),
      order: 4,
    },
  },
};

const PRODUCT_CARD_COMPACT: Json = {
  id: 'ct-shop-product-card-compact',
  name: 'Product Card • Compact',
  description:
    'A shop product in a single row for cross-sells: a small photo, name and price linking to its page, and an add button.',
  element: 'article',
  componentLevel: 'content',
  tags: ['shop'],
  props: [
    BREAKPOINT_PROP,
    ITEM_LINK,
    reg('productName'),
    reg('productPrice'),
    reg('productComparePrice'),
    reg('productImage'),
    reg('productSlug'),
    label('addLabel', 'Add button', 'Add'),
  ],
  attributes: staticAttrs(productRoot),
  classNames: ['shop-compact-card'],
  children: {
    Image: {
      ...box('a', ['shop-card-media'], { Image: media('productImage', 'Square') }, {
        attrs: { href: { prop: 'itemLink' }, tabindex: '-1', 'aria-hidden': 'true' },
      }),
      order: 1,
    },
    Info: {
      ...box('a', ['stack', 'gap-element-micro', 'shop-card-link'], {
        Name: text('span', prop('productName'), [
          'text-style-small',
          'text-weight-strong',
          'text-clamp-2',
        ]),
        Prices: PRICE_ROW('text-style-small'),
      }, { attrs: { href: { prop: 'itemLink' } } }),
      order: 2,
    },
    Add: {
      ...text('button', prop('addLabel'), ['button', 'button-secondary', 'button-small'], {
        attrs: { type: 'button', 'data-commerce-add': '' },
      }),
      order: 3,
    },
  },
};

// ── Product lists ───────────────────────────────────────────────────────────

const PRODUCT_LIST_HOVER = repeatList({
  id: 'ct-shop-product-list-hover',
  name: 'Product List • Grid • 4 Column • Hover Image',
  description: 'Shop products in a four-column grid of hover-image cards.',
  classNames: ['grid-column-4'],
  itemComponentId: 'ct-shop-product-card-hover',
  transferKey: 'Product List',
  rows: blank(4),
  list: shopList('all'),
});

const PRODUCT_TRACK = repeatList({
  id: 'ct-shop-product-track',
  name: 'Product List • Scrolling Row • Hover Image',
  description:
    'Shop products in a row that scrolls sideways, four cards and the edge of the next in view.',
  classNames: ['shop-track'],
  itemComponentId: 'ct-shop-product-card-hover',
  transferKey: 'Product List',
  rows: blank(5),
  list: shopList('all', 10, 'newest'),
});

const PRODUCT_LIST_QUICK_ADD = repeatList({
  id: 'ct-shop-product-list-quick-add',
  name: 'Product List • Grid • 4 Column • Quick Add',
  description: 'Shop products in a four-column grid of cards that add to the cart in place.',
  classNames: ['grid-column-4'],
  itemComponentId: 'ct-shop-product-card-quick-add',
  transferKey: 'Product List',
  rows: blank(4),
  list: shopList('all'),
});

const PRODUCT_LIST_COMPACT = repeatList({
  id: 'ct-shop-product-list-compact',
  name: 'Product List • Compact • 3 Column',
  description: 'Shop products as compact single-row cards, three across.',
  classNames: ['grid-column-3', 'gap-element-small'],
  itemComponentId: 'ct-shop-product-card-compact',
  transferKey: 'Product List',
  rows: blank(3),
  list: shopList('related', 3),
});

// ── Authored tiles and benefits ─────────────────────────────────────────────

const CATEGORY_TILE: Json = {
  id: 'ct-shop-category-tile',
  name: 'Category Tile • Image',
  description:
    'A link to a part of the shop as a tall photo with its name and a call to action on a gradient at its foot.',
  element: 'a',
  componentLevel: 'content',
  tags: ['shop'],
  props: [
    BREAKPOINT_PROP,
    authored(251, 'imageSource', 'image', PLACEHOLDER_IMAGE, 'Image'),
    authored(2056, 'titleText', 'richText', rich('Living'), 'Title'),
    authored(83, 'buttonLabel', 'string', 'Shop now', 'Link label'),
    authored(2059, 'itemLink', 'link', '', 'Link', 'Settings'),
  ],
  attributes: { href: { mode: 'prop', value: 'itemLink' } },
  classNames: ['shop-tile'],
  children: {
    Image: { ...media('imageSource', 'Classic Portrait'), order: 1 },
    Label: {
      ...box('div', ['shop-tile-label'], {
        Title: use(HEADING, {
          headingText: prop('titleText'),
          headingTag: 'H3',
          headingSize: 'H5',
          maxWidth: 'None',
        }),
        Action: text(
          'span',
          prop('buttonLabel'),
          ['text-style-small', 'text-weight-strong', 'text-underline'],
          { hidable: true, visible: true },
        ),
      }),
      order: 2,
    },
  },
};

const CATEGORY_TILE_LIST = repeatList({
  id: 'ct-shop-category-tile-list',
  name: 'Category Tile List • Grid • 4 Column',
  description: 'Image tiles linking to parts of the shop, four across.',
  classNames: ['grid-column-4'],
  itemComponentId: 'ct-shop-category-tile',
  transferKey: 'Category Tile List',
  rows: ['Living', 'Dining', 'Bedroom', 'Outdoor'].map((name) => ({
    titleText: rich(name),
  })),
});

const USP_ITEM: Json = {
  id: 'ct-shop-usp-item',
  name: 'Benefit Item',
  description: 'A shop promise: an icon, a short title and a line under it.',
  element: 'div',
  componentLevel: 'content',
  tags: ['shop'],
  props: [
    BREAKPOINT_PROP,
    authored(493, 'iconGlyph', 'iconName', 'local_shipping', 'Icon'),
    authored(2056, 'titleText', 'richText', rich('Free delivery'), 'Title'),
    authored(64, 'paragraphText', 'richText', rich('On orders over $100'), 'Text'),
  ],
  classNames: ['shop-usp'],
  children: {
    Icon: {
      ...use(ICON, { iconGlyph: prop('iconGlyph'), iconSize: 'Medium' }),
      order: 1,
    },
    Title: {
      ...use(HEADING, {
        headingText: prop('titleText'),
        headingTag: 'H3',
        headingSize: 'H6',
        contentHorizontalAlignment: 'Center',
        maxWidth: 'None',
      }),
      order: 2,
    },
    Text: {
      ...use(
        PARAGRAPH,
        {
          paragraphText: prop('paragraphText'),
          paragraphSize: 'Small',
          contentHorizontalAlignment: 'Center',
        },
        { hidable: true, visible: true },
      ),
      order: 3,
    },
  },
};

const USP_LIST = repeatList({
  id: 'ct-shop-usp-list',
  name: 'Benefit List • Strip • 4 Column',
  description: 'Shop promises in a ruled strip, four across.',
  classNames: ['shop-usp-strip'],
  itemComponentId: 'ct-shop-usp-item',
  transferKey: 'Benefit List',
  rows: [
    ['local_shipping', 'Free delivery', 'On orders over $100'],
    ['autorenew', 'Free 30-day returns', 'Change your mind, no fuss'],
    ['verified', '2-year warranty', 'On everything we make'],
    ['credit_card', 'Pay over time', 'Four interest-free payments'],
  ].map(([iconGlyphName, title, line]) => ({
    iconGlyph: iconGlyphName,
    titleText: rich(title!),
    paragraphText: rich(line!),
  })),
});

const REVIEW_CARD: Json = {
  id: 'ct-shop-review-card',
  name: 'Review Card',
  description: "A customer's review: stars, a title, the review and who wrote it.",
  element: 'article',
  componentLevel: 'content',
  tags: ['shop'],
  props: [
    BREAKPOINT_PROP,
    {
      ...authored(58, 'starRating', 'enum', '5', 'Rating'),
      enumValues: ['0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5', '5'],
    },
    authored(2056, 'titleText', 'richText', rich('Worth every cent'), 'Title'),
    authored(
      64,
      'paragraphText',
      'richText',
      rich('Arrived quickly and looks even better than the photos. The quality is obvious the moment you unbox it.'),
      'Review',
    ),
    authored(68, 'labelText', 'string', 'Sam R. · Verified buyer', 'Reviewer'),
  ],
  classNames: ['shop-review-card'],
  children: {
    Stars: { ...use(STAR_RATING, { starRating: prop('starRating'), starRatingSize: 'Small' }), order: 1 },
    Title: {
      ...use(HEADING, {
        headingText: prop('titleText'),
        headingTag: 'H3',
        headingSize: 'H6',
        maxWidth: 'None',
      }),
      order: 2,
    },
    Body: {
      ...use(PARAGRAPH, {
        paragraphText: prop('paragraphText'),
        paragraphSize: 'Small',
        textTruncate: '3 Lines',
        maxWidth: 'None',
      }),
      order: 3,
    },
    Reviewer: { ...text('span', prop('labelText'), ['text-style-tiny', 'shop-muted']), order: 4 },
  },
};

const REVIEW_LIST = repeatList({
  id: 'ct-shop-review-list',
  name: 'Review List • 3 Column',
  description: 'Customer reviews, three across.',
  classNames: ['grid-column-3'],
  itemComponentId: 'ct-shop-review-card',
  transferKey: 'Review List',
  rows: [
    {},
    {
      starRating: '5',
      titleText: rich('So comfortable'),
      paragraphText: rich('I was unsure about ordering online, but the fit is perfect and returns were easy to understand.'),
      labelText: 'Priya K. · Verified buyer',
    },
    {
      starRating: '4',
      titleText: rich('Great value'),
      paragraphText: rich('Lovely finish and well packed. Took a few days longer than expected to arrive.'),
      labelText: 'James T. · Verified buyer',
    },
  ],
});

// ── Sections ────────────────────────────────────────────────────────────────

const PRODUCT_CAROUSEL = section({
  id: 'sc-shop-product-carousel',
  name: 'Products • Scrolling Row',
  description:
    'A heading with a "View all" link over a sideways-scrolling row of shop products with hover images, for new arrivals or best sellers on the home page and below a product.',
  props: [
    HEADING_TEXT('New arrivals'),
    LINK_LABEL('View all'),
    LINK_HREF,
    reg('shopList', shopList('all', 10, 'newest')),
  ],
  children: {
    Header: headingRow(),
    'Product List': use('ct-shop-product-track', { shopList: prop('shopList') }),
  },
});

const PRODUCT_GRID_QUICK_ADD = section({
  id: 'sc-shop-product-grid-quick-add',
  name: 'Products • Grid • Quick Add',
  description:
    'A heading over a grid of shop products that shoppers add to the cart without leaving the page, picking an option on the card when the product has them.',
  props: [HEADING_TEXT('Best sellers'), reg('shopList', shopList('all'))],
  children: {
    'Section Content Block': use(
      CONTENT_BLOCK,
      {
        contentHorizontalAlignment: 'Left',
        hasHeaderAction: false,
        headingText: prop('headingText'),
      },
      { hidable: true, visible: true },
    ),
    'Product List': use('ct-shop-product-list-quick-add', {
      shopList: prop('shopList'),
    }),
  },
});

const FEATURED_PRODUCT = section({
  id: 'sc-shop-featured-product',
  name: 'Product • Featured on Photo',
  description:
    'A large photo with one shop product on a floating card over it: a tag, its name, short description, price, and buttons to add it to the cart or see more. For launching a product on the home page.',
  props: [
    authored(251, 'imageSource', 'image', PLACEHOLDER_IMAGE, 'Background image'),
    reg('shopList', shopList('all', 1, 'newest')),
  ],
  children: {
    Container: box('div', ['container'], {
      Feature: box('div', ['shop-feature'], {
        Image: box('div', [], { Image: media('imageSource', 'Fill') }, {
          attrs: { 'data-feature-image': '' },
        }),
        'Product List': use('ct-shop-featured-product-list', {
          shopList: prop('shopList'),
        }),
      }),
    }),
  },
});

const FEATURED_PRODUCT_CARD: Json = {
  id: 'ct-shop-featured-product-card',
  name: 'Product Card • Featured',
  description:
    'One shop product as a large card: a tag, its name, short description, price, add to cart and a link to its page.',
  element: 'article',
  componentLevel: 'content',
  tags: ['shop'],
  props: [
    BREAKPOINT_PROP,
    ITEM_LINK,
    reg('productName'),
    reg('productSummary'),
    reg('productPrice'),
    reg('productComparePrice'),
    reg('productSlug'),
    authored(2143, 'tagText', 'string', 'New', 'Tag'),
    label('addLabel', 'Add button', 'Add to cart'),
    label('moreLabel', 'Link button', 'Find out more'),
  ],
  attributes: staticAttrs(productRoot),
  classNames: ['shop-feature-card'],
  children: {
    Tag: { ...use('el-chip', { tagText: prop('tagText'), tagSize: 'Small' }, { hidable: true, visible: true }), order: 1 },
    Heading: {
      ...use(HEADING, {
        headingText: prop('productName'),
        headingTag: 'H2',
        headingSize: 'H2',
        maxWidth: 'None',
      }),
      order: 2,
    },
    Summary: {
      ...use(
        PARAGRAPH,
        { paragraphText: prop('productSummary'), maxWidth: 'None' },
        { hidable: true, visible: true },
      ),
      order: 3,
    },
    Prices: { ...PRICE_ROW('heading-style-h5'), order: 4 },
    Buttons: {
      ...box('div', ['button-group'], {
        Add: text('button', prop('addLabel'), ['button'], {
          attrs: { type: 'button', 'data-commerce-add': '' },
        }),
        More: text('a', prop('moreLabel'), ['button', 'button-secondary'], {
          attrs: { href: { prop: 'itemLink' } },
        }),
      }),
      order: 5,
    },
  },
};

const FEATURED_PRODUCT_LIST = repeatList({
  id: 'ct-shop-featured-product-list',
  name: 'Product List • Featured',
  description: 'One shop product, as a featured card.',
  classNames: [],
  itemComponentId: 'ct-shop-featured-product-card',
  transferKey: 'Product List',
  rows: blank(1),
  list: shopList('all', 1, 'newest'),
});

const CATEGORY_TILES = section({
  id: 'sc-shop-category-tiles',
  name: 'Categories • Image Tiles',
  description:
    'A heading over tall photo tiles, each linking to a part of the shop with its name on the photo. Photos and links are chosen per tile.',
  props: [HEADING_TEXT('Shop by room')],
  children: {
    'Section Content Block': use(
      CONTENT_BLOCK,
      {
        contentHorizontalAlignment: 'Left',
        hasHeaderAction: false,
        headingText: prop('headingText'),
      },
      { hidable: true, visible: true },
    ),
    'Category Tile List': use('ct-shop-category-tile-list'),
  },
});

const USP_STRIP = section({
  id: 'sc-shop-benefits-strip',
  name: 'Benefits • Strip',
  description:
    "A ruled strip of the shop's promises (delivery, returns, warranty, payment), each an icon, a title and a line. For the foot of the home page or under a product.",
  props: [],
  classNames: ['section-small', 'scheme-1'],
  children: {
    'Benefit List': use('ct-shop-usp-list'),
  },
});

const chip = (name: string) =>
  text('a', name, ['shop-chip'], { attrs: { href: '#' } });

const CATEGORY_BANNER = section({
  id: 'sc-shop-category-banner',
  name: 'Category • Banner, Links and Products',
  description:
    "A category page: a breadcrumb, the category's name and description on a photo banner, a row of links to related parts of the shop, then a grid of its products with hover images and a Load more button.",
  props: [
    reg('categoryName'),
    reg('categoryDescription'),
    authored(251, 'imageSource', 'image', PLACEHOLDER_IMAGE, 'Banner image'),
    authored(2184, 'breadcrumbHomeHref', 'link', '/', 'Home link', 'Settings'),
    reg('shopList', shopList('category', 12)),
    label('moreLabel', 'Load more button', 'Load more'),
  ],
  children: {
    Banner: box('div', ['shop-banner'], {
      Image: box('div', [], { Image: media('imageSource', 'Fill') }, {
        attrs: { 'data-banner-image': '' },
      }),
      Content: box('div', ['shop-banner-content'], {
        Breadcrumb: box('nav', ['shop-breadcrumb'], {
          Home: text('a', 'Home', [], { attrs: { href: { prop: 'breadcrumbHomeHref' } } }),
          Separator: text('span', '/', [], { attrs: { 'aria-hidden': 'true' } }),
          Current: text('span', prop('categoryName'), [], {
            attrs: { 'aria-current': 'page' },
          }),
        }, { attrs: { 'aria-label': 'Breadcrumb' } }),
        Heading: use(HEADING, {
          headingText: prop('categoryName'),
          headingTag: 'H1',
          headingSize: 'H1',
          maxWidth: 'None',
        }),
        Paragraph: use(
          PARAGRAPH,
          {
            paragraphText: prop('categoryDescription'),
            paragraphSize: 'Medium',
            textTruncate: '2 Lines',
          },
          { hidable: true, visible: true },
        ),
      }),
    }),
    Links: box(
      'nav',
      ['shop-chips'],
      Object.fromEntries(
        ['Sofas', 'Armchairs', 'Coffee tables', 'Side tables', 'Rugs'].map(
          (name, i) => [`Link ${i + 1}`, chip(name)],
        ),
      ),
      { hidable: true, visible: true, attrs: { 'aria-label': 'Related categories' } },
    ),
    Products: use('ct-shop-product-list-hover', { shopList: prop('shopList') }),
    More: text('button', prop('moreLabel'), ['button', 'button-secondary'], {
      attrs: { type: 'button', 'data-shop-more': '' },
    }),
  },
});

const PAIR_WITH = section({
  id: 'sc-shop-pair-with',
  name: 'Products • Pair It With',
  description:
    "A heading over compact cards of products related to the page's product, each with its own add button, on a tinted band. For a product page's cross-sell.",
  props: [HEADING_TEXT('Pair it with'), reg('shopList', shopList('related', 3))],
  classNames: ['section-small', 'scheme-1'],
  children: {
    Container: box('div', ['container'], {
      Panel: box('div', ['shop-summary-card'], {
        Heading: use(HEADING, {
          headingText: prop('headingText'),
          headingTag: 'H2',
          headingSize: 'H5',
          maxWidth: 'None',
        }),
        'Product List': use('ct-shop-product-list-compact', {
          shopList: prop('shopList'),
        }),
      }),
    }),
  },
});

const BUY_BAR = section({
  id: 'sc-shop-buy-bar',
  name: 'Product • Sticky Buy Bar',
  description:
    "A bar that stays at the foot of the screen on a product page: the product's photo, name and price, quantity and add to cart, so shoppers can buy from anywhere on the page. Place it last on the page.",
  props: [
    reg('productName'),
    reg('productPrice'),
    reg('productComparePrice'),
    reg('productImage'),
    reg('productSlug'),
    label('addLabel', 'Add button', 'Add to cart'),
  ],
  attrs: productRoot,
  classNames: ['shop-buy-bar', 'scheme-1'],
  children: {
    Container: box('div', ['container'], {
      Bar: box('div', ['shop-buy-bar-inner'], {
        Image: box('div', ['shop-card-media'], {
          Image: media('productImage', 'Square'),
        }),
        Info: box('div', ['stack', 'gap-element-micro'], {
          Name: text('span', prop('productName'), [
            'text-style-regular',
            'text-weight-strong',
            'text-clamp-1',
          ]),
          Prices: box('div', ['row', 'gap-element-horizontal-small'], {
            Price: text('span', prop('productPrice'), ['text-style-small'], {
              attrs: { 'data-commerce-price': '' },
            }),
            'Compare Price': text(
              's',
              prop('productComparePrice'),
              ['text-style-small', 'shop-compare'],
              { attrs: { 'data-commerce-compare-price': '' } },
            ),
          }),
        }),
        Buy: box('div', ['shop-buy-row'], {
          Quantity: empty('input', ['input', 'shop-qty'], {
            attrs: {
              type: 'number',
              min: '1',
              value: '1',
              'aria-label': 'Quantity',
              'data-commerce-quantity': '',
            },
          }),
          Add: text('button', prop('addLabel'), ['button'], {
            attrs: { type: 'button', 'data-commerce-add': '' },
          }),
        }),
      }),
    }),
  },
});

const histogramRow = (stars: number, share: number) =>
  box('div', ['shop-histogram-row'], {
    Stars: text('span', `${stars} ★`),
    Bar: box('div', ['shop-histogram-bar'], {
      Fill: box('div', [], {}, { style: { width: s(`${share}%`) } }),
    }, { attrs: { 'aria-hidden': 'true' } }),
    Share: text('span', `${share}%`, ['shop-muted']),
  });

const REVIEWS = section({
  id: 'sc-shop-reviews',
  name: 'Reviews • Score and Cards',
  description:
    "The shop's or a product's review score: the average, its stars, the review count and a five-row histogram, beside three review cards. Written in the Editor; the shop has no reviews yet.",
  props: [
    HEADING_TEXT('What our customers say'),
    authored(2142, 'ctaParagraphText', 'richText', rich('Based on 1,284 reviews'), 'Review count'),
    label('scoreText', 'Score', '4.8'),
  ],
  children: {
    Header: use(HEADING, {
      headingText: prop('headingText'),
      headingTag: 'H2',
      headingSize: 'H3',
      maxWidth: 'None',
    }),
    Reviews: box('div', ['shop-reviews'], {
      Summary: box('div', ['stack', 'gap-element-medium'], {
        Score: box('div', ['stack', 'gap-element-tiny'], {
          Value: text('span', prop('scoreText'), ['shop-score']),
          Stars: use(STAR_RATING, { starRating: '5' }),
          Count: use(PARAGRAPH, {
            paragraphText: prop('ctaParagraphText'),
            paragraphSize: 'Small',
          }),
        }),
        Histogram: box(
          'div',
          ['stack', 'gap-element-tiny'],
          {
            'Row 5': histogramRow(5, 82),
            'Row 4': histogramRow(4, 12),
            'Row 3': histogramRow(3, 4),
            'Row 2': histogramRow(2, 1),
            'Row 1': histogramRow(1, 1),
          },
          { hidable: true, visible: true },
        ),
      }),
      'Review List': use('ct-shop-review-list'),
    }),
  },
});

export const COMPONENTS: Json[] = [
  PRODUCT_CARD_HOVER,
  PRODUCT_CARD_QUICK_ADD,
  PRODUCT_CARD_COMPACT,
  FEATURED_PRODUCT_CARD,
  PRODUCT_LIST_HOVER,
  PRODUCT_TRACK,
  PRODUCT_LIST_QUICK_ADD,
  PRODUCT_LIST_COMPACT,
  FEATURED_PRODUCT_LIST,
  CATEGORY_TILE,
  CATEGORY_TILE_LIST,
  USP_ITEM,
  USP_LIST,
  REVIEW_CARD,
  REVIEW_LIST,
  PRODUCT_CAROUSEL,
  PRODUCT_GRID_QUICK_ADD,
  FEATURED_PRODUCT,
  CATEGORY_TILES,
  USP_STRIP,
  CATEGORY_BANNER,
  PAIR_WITH,
  BUY_BAR,
  REVIEWS,
];

/** Where each section was seen, for review; screenshots are of the crawled sites. */
export const REFERENCES: Record<string, { pages: string[]; seenOn: string[] }> = {
  'sc-shop-product-carousel': {
    pages: ['home', 'product'],
    seenOn: ['Castlery home', 'Koala category', 'Text Publishing home', 'Bulk Nutrients home', 'Woolworths category'],
  },
  'sc-shop-product-grid-quick-add': {
    pages: ['home', 'category'],
    seenOn: ['Bulk Nutrients home', 'Cygnett category', 'The Source Bulk Foods category', 'Dandelion Vineyards category'],
  },
  'sc-shop-featured-product': {
    pages: ['home'],
    seenOn: ['Bulk Nutrients home hero', 'Cygnett home callout'],
  },
  'sc-shop-category-tiles': {
    pages: ['home'],
    seenOn: ['Beaumont Tiles home', 'Kate & Kole home', 'Koala home', 'Castlery home', 'UGG Outlet home', 'National Tiles home'],
  },
  'sc-shop-benefits-strip': {
    pages: ['home', 'category', 'product'],
    seenOn: ['Beaumont Tiles (every page)', 'Bulk Nutrients home', 'National Tiles home', 'Castlery home'],
  },
  'sc-shop-category-banner': {
    pages: ['category'],
    seenOn: ['Koala category', 'Bondi Sands category', 'Castlery category', 'Bulk Nutrients category', 'Kate & Kole category'],
  },
  'sc-shop-pair-with': {
    pages: ['product'],
    seenOn: ['Castlery "Pair it with our picks"', 'Koala "Make it a set"', 'JB Hi-Fi "Frequently bought together"'],
  },
  'sc-shop-buy-bar': {
    pages: ['product'],
    seenOn: ['UGG Outlet product', 'Koala product', 'Castlery product', 'Kate & Kole product', 'Bulk Nutrients product'],
  },
  'sc-shop-reviews': {
    pages: ['home', 'product'],
    seenOn: ['Woolworths product', 'Beaumont Tiles home', 'Bulk Nutrients home', 'National Tiles home'],
  },
};
