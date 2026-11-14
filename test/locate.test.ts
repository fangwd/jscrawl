import { amountOf, locateValues, renderLocations } from '../src/core/locate';

const page = `<html><head>
  <meta property="og:title" content="Walnut Desk">
  <script type="application/ld+json">{"@type":"Product","name":"Walnut Desk","sku":"WD-120","offers":{"price":"1234.50"}}</script>
  <script>window.__STATE__ = {"product":{"title":"Walnut Desk","priceCents":123450,"variants":[{"sku":"WD-120"}]}};</script>
  <script id="cfg" type="application/json">{"brand":"Oakline"}</script>
</head><body class="product-page">
  <div class="product"><h1 class="product-title">Walnut   Desk</h1>
    <div class="price-box"><span class="price">$1,234.50</span></div>
    <button data-sku="WD-120">Add</button>
    <p class="blurb">The Walnut Desk seats two and ships flat.</p></div>
  <div class="card"><span class="price">$99.00</span></div>
</body></html>`;

test('a value is found in every source that holds it, cheapest first', () => {
  const located = locateValues(page, 'https://shop.test/p', { name: 'Walnut Desk' }, [
    {
      name: 'detail.json',
      body: '{"data":{"items":[{"name":"Walnut Desk"}]}}',
    },
  ]);
  expect(located.name.map((location) => [location.source, location.where, location.of])).toEqual([
    ['json', 'data.items.0.name', 'detail.json'],
    ['embedded', 'product.title', 'window.__STATE__ ='],
    ['json-ld', 'name', 'Product'],
    ['attribute', 'meta[property="og:title"][content]', 'the only match'],
    ['dom', 'div.product > h1.product-title', 'the only match'],
  ]);
});

test('an amount matches however the source formats it', () => {
  const { price } = locateValues(page, 'https://shop.test/p', {
    price: '$1,234.50',
  });
  expect(price.map((location) => [location.source, location.where, location.note])).toEqual([
    ['embedded', 'product.priceCents', 'in cents'],
    ['json-ld', 'offers.price', 'same amount, formatted differently'],
    ['dom', 'div.product > div.price-box > span.price', undefined],
  ]);
  expect(amountOf('$1,234.50')).toBe(1234.5);
  expect(amountOf('1234.5 AUD')).toBe(1234.5);
  expect(amountOf('From $850')).toBe(850);
  expect(amountOf('850')).toBe(850);
  expect(amountOf('12 x 30')).toBeUndefined();
  expect(amountOf('WD-120')).toBeUndefined();
  expect(amountOf('2 seats')).toBeUndefined();
  expect(amountOf('Walnut Desk')).toBeUndefined();
});

test('an attribute, a script by id, and a text that only contains the value', () => {
  const located = locateValues(page, 'https://shop.test/p', {
    sku: 'WD-120',
    brand: 'Oakline',
    claim: 'seats two and ships flat',
  });
  expect(located.sku.map((location) => `${location.source} ${location.where}`)).toEqual([
    'embedded product.variants.0.sku',
    'json-ld sku',
    'attribute button[data-sku]',
  ]);
  expect(located.brand).toEqual([
    { source: 'embedded', where: 'brand', of: '#cfg', found: 'Oakline' },
  ]);
  expect(located.claim).toEqual([
    {
      source: 'dom',
      where: 'div.product > p.blurb',
      of: 'the only match',
      found: 'The Walnut Desk seats two and ships flat.',
      note: 'the text contains it',
    },
  ]);
});

test('the report says what was not found and which source carries the most', () => {
  const values = { name: 'Walnut Desk', price: '$1,234.50', colour: 'Teal' };
  const text = renderLocations(values, locateValues(page, 'https://shop.test/p', values));
  expect(text).toContain('colour: "Teal"\n  not found');
  expect(text).toContain(
    'sources by values carried, of 3: embedded window.__STATE__ = 2, json-ld Product 2, dom 2, attribute 1',
  );
  expect(text).toContain('not found: colour');
});

test('a selector is built from classes that name content, not utility classes', () => {
  const html = `<body><div class="flex flex-col gap-y-2"><h1 class="flex text-lg product__title mt-4">Oak Shelf</h1></div></body>`;
  expect(locateValues(html, 'https://shop.test/p', { name: 'Oak Shelf' }).name[0].where).toBe(
    'div > h1.product__title',
  );
});

test('a code is not matched as an amount, and items of an array are one location', () => {
  const html = `<script id="d" type="application/json">{"variants":[{"sku":"AB-120","price":4500},{"sku":"WD-120","price":4500},{"sku":"ZZ-9","price":4500}]}</script>
    <body><span class="sku">AB-120</span></body>`;
  const located = locateValues(html, 'https://shop.test/p', {
    sku: 'WD-120',
    price: '$45.00',
  });
  expect(located.sku).toEqual([
    { source: 'embedded', where: 'variants.1.sku', of: '#d', found: 'WD-120' },
  ]);
  expect(located.price).toEqual([
    {
      source: 'embedded',
      where: 'variants.0.price',
      of: '#d',
      found: '4500',
      note: 'in cents; and 2 more at the same path of other items',
    },
  ]);
});
