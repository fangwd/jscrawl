import { readFileSync } from 'fs';
import { parse } from 'gumbo-html';
import {
  breadcrumbs,
  decodeEntities,
  embeddedJson,
  findType,
  imageUrl,
  jsonFragment,
  jsonLd,
  parsePrice,
  productFromJsonLd,
  specPairs,
  specSections,
  visibleText,
  htmlText,
} from '../src/core/extract';

const fixture = (name: string, baseUrl: string) =>
  parse(readFileSync(`test/fixtures/${name}.html`, 'utf8'), { baseUrl });

const IDEAL = 'https://www.idealbathroomcentre.com.au/products/milano-cerchio-concrete-380mm-above-counter-basin-tan-brown';
const BEAUMONT = 'https://www.beaumont-tiles.com.au/1235473-chevron-nordic-isocore';

describe('jsonLd', () => {
  test('flattens arrays and @graph, skipping malformed blocks', () => {
    const doc = parse(`
      <script type="application/ld+json">[{"@type":"Organization"}]</script>
      <script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":["Product","Thing"]}]}</script>
      <script type="application/ld+json">{ not json</script>
      <script>{"@type":"Ignored"}</script>`);
    const nodes = jsonLd(doc);
    expect(nodes.map((n) => n['@type'])).toEqual(['Organization', 'WebPage', ['Product', 'Thing']]);
    expect(findType(nodes, 'Product')).toHaveLength(1);
  });
});

describe('productFromJsonLd', () => {
  test('merges a Shopify ProductGroup published twice', () => {
    const data = productFromJsonLd(jsonLd(fixture('ideal-bathroom-product', IDEAL)))!;
    expect(data.product).toMatchObject({
      code: '9714724798695',
      name: 'Milano Cerchio Concrete 380mm Above Counter Basin, Tan Brown',
      brand: 'Milano',
    });
    expect(data.product.description).toMatch(/^The Milano Cerchio/);
    expect(data.variants).toEqual([
      {
        code: 'BA-CER383810TB',
        sku: 'BA-CER383810TB',
        name: 'Milano Cerchio Concrete 380mm Above Counter Basin, Tan Brown - Tan Brown',
        price: 326.55,
        availability: 'in_stock',
        values: {},
      },
    ]);
    // the variant does not state its colour, so there is no axis to record
    expect(data.attributes).toEqual([]);
    expect(data.images[0]).toMatch(/tan-brown-1\.png/);
    expect(data.images).toHaveLength(3);
  });

  test('keeps every labelled unit price an offer quotes', () => {
    const data = productFromJsonLd([
      {
        '@type': 'Product',
        sku: 'NT18-4080WL',
        name: 'Whoosh White Gloss Tile',
        offers: {
          price: '79.10',
          priceCurrency: 'AUD',
          availability: 'https://schema.org/InStock',
          priceSpecification: [
            { price: '79.10', priceCurrency: 'AUD', referenceQuantity: { unitCode: 'C62' } },
            {
              name: 'Price per square meter',
              price: '39.95',
              priceCurrency: 'AUD',
              referenceQuantity: { unitCode: 'MTK' },
            },
          ],
        },
      },
    ] as any)!;
    // The unnamed specification is the variant's own unit price; the named one
    // is what a shopper reads as "per square metre", and a variant has one
    // unitPrice column, so it becomes an attribute.
    expect(data.variants[0]).toMatchObject({ price: 79.1, unitPrice: 79.1, unit: 'C62', availability: 'in_stock' });
    expect(data.attributes).toEqual([
      { groupName: 'Pricing', name: 'Price per square meter', values: ['39.95 AUD per MTK'] },
    ]);
  });

  test('reads offers, price specifications, ratings and variant axes', () => {
    const data = productFromJsonLd([
      {
        '@type': 'ProductGroup',
        productGroupID: 'G1',
        name: ' Tile ',
        brand: 'Acme',
        aggregateRating: { ratingValue: '4.5', ratingCount: 12 },
        variesBy: ['https://schema.org/size'],
        hasVariant: [
          {
            '@type': 'Product',
            sku: 'T-S',
            gtin13: '9300000000017',
            size: 'Small',
            image: { '@type': 'ImageObject', contentUrl: 'https://x.test/s.jpg' },
            offers: {
              '@type': 'Offer',
              availability: 'https://schema.org/OutOfStock',
              priceSpecification: [
                { '@type': 'UnitPriceSpecification', price: 40, referenceQuantity: { unitText: 'm2' } },
                { '@type': 'UnitPriceSpecification', price: 55, priceType: 'https://schema.org/StrikethroughPrice' },
                { '@type': 'UnitPriceSpecification', price: 45 },
              ],
            },
          },
          {
            '@type': 'Product',
            sku: 'T-L',
            size: { name: 'Large' },
            offers: { '@type': 'AggregateOffer', offers: [{ '@type': 'Offer', price: '60.00' }] },
          },
        ],
      },
    ])!;
    expect(data.product).toMatchObject({ code: 'G1', name: 'Tile', brand: 'Acme', ratingValue: 4.5, reviewCount: 12 });
    expect(data.attributes).toEqual([{ name: 'Size', values: ['Small', 'Large'] }]);
    expect(data.variants).toEqual([
      {
        code: 'T-S',
        sku: 'T-S',
        gtin: '9300000000017',
        price: 45,
        compareAtPrice: 55,
        unitPrice: 40,
        unit: 'm2',
        availability: 'out_of_stock',
        values: { Size: 'Small' },
      },
      { code: 'T-L', sku: 'T-L', price: 60, values: { Size: 'Large' } },
    ]);
    expect(data.images).toEqual(['https://x.test/s.jpg']);
  });

  test('a plain Product gets one default variant', () => {
    const data = productFromJsonLd([
      { '@type': 'Product', sku: 'P1', offers: [{ '@type': 'Offer', price: 10, availability: 'InStock' }] },
    ])!;
    expect(data.variants).toEqual([{ code: '', sku: 'P1', price: 10, availability: 'in_stock' }]);
  });

  test('returns null without a product', () => {
    expect(productFromJsonLd([{ '@type': 'WebSite' }])).toBeNull();
  });
});

describe('breadcrumbs', () => {
  test('prefers JSON-LD, where crumbs carry links', () => {
    expect(breadcrumbs(fixture('beaumont-tiles-product', BEAUMONT), '.breadcrumbs li')).toEqual([
      { name: 'Home', url: 'https://www.beaumont-tiles.com.au/' },
      { name: 'Tiles', url: 'https://www.beaumont-tiles.com.au/tiles' },
    ]);
  });

  test('falls back to the DOM, resolving links', () => {
    const doc = parse(
      `<ol class="crumbs"><li><a href="/">Home</a></li><li><a href="/tiles/">  Floor
        Tiles </a></li><li>Nordic</li></ol>`,
      { baseUrl: 'https://shop.test/p/1' }
    );
    expect(breadcrumbs(doc, '.crumbs li')).toEqual([
      { name: 'Home', url: 'https://shop.test/' },
      { name: 'Floor Tiles', url: 'https://shop.test/tiles/' },
      { name: 'Nordic' },
    ]);
    expect(breadcrumbs(doc)).toEqual([]);
  });
});

describe('specPairs', () => {
  test('reads th/td, td/td and dt/dd pairs', () => {
    const doc = parse(`
      <table><tr><th>Material:</th><td> Concrete </td></tr><tr><td>Size</td><td>380 x 380</td></tr>
        <tr><th>Empty</th><td> </td></tr><tr><td colspan="2">Note</td></tr></table>
      <dl><dt>Shape</dt><dd>Round</dd><dt>Finish</dt><dd>Matt</dd></dl>`);
    expect(specPairs(doc)).toEqual([
      { name: 'Material', value: 'Concrete' },
      { name: 'Size', value: '380 x 380' },
      { name: 'Shape', value: 'Round' },
      { name: 'Finish', value: 'Matt' },
    ]);
  });

  test('reads custom label/value rows', () => {
    const doc = parse(`
      <div class="attr"><span class="label">Colour</span><span class="value">Tan
        Brown</span></div>
      <div class="attr"><span class="label">Waste</span></div>`);
    expect(specPairs(doc, { row: '.attr', name: '.label', value: '.value' })).toEqual([
      { name: 'Colour', value: 'Tan Brown' },
    ]);
  });
});

describe('imageUrl', () => {
  const img = (attrs: string) => parse(`<img ${attrs}>`).firstOrThrow('img');

  test('picks the largest srcset candidate', () => {
    expect(imageUrl(img('src="s.jpg" srcset="m.jpg 800w, l.jpg 1600w, s.jpg 400w"'))).toBe('l.jpg');
    expect(imageUrl(img('srcset="a.jpg, b.jpg 2x"'))).toBe('b.jpg');
  });

  test('prefers lazy-load sources over placeholders', () => {
    expect(imageUrl(img('src="data:image/gif;base64,R0lG" data-src="/real.jpg"'))).toBe('/real.jpg');
    expect(imageUrl(img('src="plain.jpg"'))).toBe('plain.jpg');
    expect(imageUrl(img('alt="none"'))).toBeUndefined();
  });
});

describe('parsePrice', () => {
  test.each([
    ['$1,234.50', { amount: 1234.5 }],
    ['From $45', { amount: 45 }],
    ['$89.90 per m²', { amount: 89.9, unit: 'm2' }],
    ['$4.50/kg', { amount: 4.5, unit: 'kg' }],
    ['AU$ 12 000', { amount: 12000 }],
  ])('%s', (text, price) => {
    expect(parsePrice(text)).toEqual(price);
  });

  test('returns null without an amount', () => {
    expect(parsePrice('Call for price')).toBeNull();
  });
});

describe('embeddedJson', () => {
  test('returns the JSON assigned after the marker, skipping non-JSON occurrences', () => {
    const doc = parse(`
      <script>window.shop.product = null; var other = 1;</script>
      <script>window.shop.product = {title: 'not json'};</script>
      <script>
        window.shop.product = {"title":"Bath {1700mm}","sizes":["S","L"],"note":"a \\"quoted\\" ]"};
        window.shop.cart = [];
      </script>`);
    expect(embeddedJson(doc, 'window.shop.product =')).toEqual({ title: 'Bath {1700mm}', sizes: ['S', 'L'], note: 'a "quoted" ]' });
    expect(embeddedJson(doc, 'window.shop.cart =')).toEqual([]);
    expect(embeddedJson(doc, 'window.missing =')).toBeUndefined();
  });
});

describe('jsonFragment', () => {
  test('reads JSON from an attribute, which the parser hands over decoded', () => {
    const doc = parse(
      `<section data-bind="scope: 'menu', data: {&quot;elems&quot;:[{&quot;label&quot;:&quot;Tiles &amp; Stone&quot;}]}"></section>`
    );
    const binding = doc.first('section')!.attr_s('data-bind');
    expect(binding).toContain('"elems"');
    expect(jsonFragment(binding, 'data: {')).toEqual({ elems: [{ label: 'Tiles & Stone' }] });
  });

  test('takes the first balanced object or array, with or without a marker', () => {
    expect(jsonFragment('noise {"a":{"b":[1,2]}} noise')).toEqual({ a: { b: [1, 2] } });
    expect(jsonFragment('x = [1,2];', 'x =')).toEqual([1, 2]);
    expect(jsonFragment('v = {"a":"}{ "}')).toEqual({ a: '}{ ' });
  });

  test('skips candidates that are not JSON and gives up when none is', () => {
    expect(jsonFragment('v = {not json}; v = {"a":1}', 'v =')).toEqual({ a: 1 });
    expect(jsonFragment('v = {"a":1', 'v =')).toBeUndefined();
    expect(jsonFragment('nothing here', 'v =')).toBeUndefined();
    expect(jsonFragment('no brackets at all')).toBeUndefined();
  });
});

describe('decodeEntities', () => {
  test('decodes one level, so a reference that decodes to an ampersand survives', () => {
    expect(decodeEntities('&amp;quot;')).toBe('&quot;');
    expect(decodeEntities('&lt;b&gt; &quot;q&quot; &#39;a&#39; &#x41; &nbsp;')).toBe('<b> "q" \'a\' A \u00a0');
  });

  test('leaves unknown references and bare ampersands alone', () => {
    expect(decodeEntities('&unknown; &amp &notaref')).toBe('&unknown; &amp &notaref');
    expect(decodeEntities('plain text')).toBe('plain text');
  });
});

describe('specSections', () => {
  test('splits pasted tables on colspan heading rows and reads th/td and td/td pairs', () => {
    const doc = parse(`
      <table>
        <tr><td colspan="2">Product Information</td></tr>
        <tr><td>Material</td><td>Brass</td></tr>
        <tr><th>Finish</th><td>Chrome</td></tr>
        <tr><td colspan="2">Dimensions</td></tr>
        <tr><td>Height</td><td>800mm</td></tr>
      </table>`);
    expect(specSections(doc.first('table')!)).toEqual([
      { title: 'Product Information', pairs: [{ name: 'Material', value: 'Brass' }, { name: 'Finish', value: 'Chrome' }] },
      { title: 'Dimensions', pairs: [{ name: 'Height', value: '800mm' }] },
    ]);
  });

  test('comparison and column-header rows yield no sections', () => {
    const doc = parse(`
      <table>
        <tr><th>Feature</th><th>Essential</th><th>Ultimate</th></tr>
        <tr><td>Warranty</td><td>1y</td><td>10y</td></tr>
      </table>`);
    expect(specSections(doc.first('table')!)).toEqual([]);
  });

  test('a table without headings is one untitled section', () => {
    const doc = parse(`<table><tr><th>Model</th><td>X1</td></tr><tr><th>Colour</th><td>White</td></tr></table>`);
    expect(specSections(doc.first('table')!)).toEqual([
      { title: null, pairs: [{ name: 'Model', value: 'X1' }, { name: 'Colour', value: 'White' }] },
    ]);
  });
});

describe('visibleText', () => {
  test('skips style and script contents, and keeps words split across elements', () => {
    const doc = parse(`
      <div id="faq">
        <style>.font-bold { font-weight: bold }</style>
        <p>What <script>var tracked = 1;</script>size do I need?</p>
        <span class="price">$159<span class="cents">95</span></span>
      </div>`);
    const element = doc.first('#faq')!;
    expect(element.text({ normalize: true })).toContain('.font-bold');
    expect(visibleText(element)).toBe('What size do I need? $15995');
  });

  test('an element with only code in it has no visible text', () => {
    const doc = parse('<div id="x"><style>a{}</style><script>b()</script></div>');
    expect(visibleText(doc.first('#x')!)).toBe('');
  });
});

describe('htmlText', () => {
  test('one line per block, words split across inline elements kept whole', () => {
    const html = '<h3>Features</h3><p>Equipped wi<span>th</span> 2x USB-A,<br>and   1x USB-C</p><ul><li>Slim design</li></ul>';
    expect(htmlText(html)).toBe('Features\nEquipped with 2x USB-A,\nand 1x USB-C\nSlim design');
    expect(htmlText('')).toBe('');
  });
});
