import { parse } from 'gumbo-html';
import { checkCompleteness, FixturePages, FixtureSection, SectionContract } from '../src/core/completeness';

const html = `
  <p id="description">A warm walnut with a weathered look.</p>
  <button role="tab" aria-controls="applications">Applications</button>
  <div role="tabpanel" id="applications"><ul><li>Benchtops</li><li>Shelving</li></ul></div>`;
const sections: SectionContract[] = [
  { name: 'Description', selector: '#description', status: 'extracted', evidence: 'warm walnut',
    expect: [{ table: 'product', field: 'description', contains: ['weathered look'] }] },
  { name: 'Applications', selector: '#applications', status: 'extracted', evidence: 'Benchtops',
    expect: [{ table: 'product_attribute_value', field: 'value', where: { 'attribute.name': 'Applications' },
      minCount: 2, values: ['Benchtops', 'Shelving'] }] },
];
const applications = ['Benchtops', 'Shelving'].map((value) => ({ value, attribute: { name: 'Applications' } }));
const report = (data: { [table: string]: unknown[] }, contract = sections, page = html) =>
  checkCompleteness(parse(page), contract, (table) => data[table] ?? []);

test('a thin product with ordinary specs still fails missing description and applications', () => {
  const result = report({ product: [{ name: 'Walnut' }], product_attribute_value: [
    { value: 'Walnut', attribute: { name: 'Colour' } },
    { value: '6055', attribute: { name: 'Colour Code' } },
    { value: 'Matte', attribute: { name: 'Finish' } },
  ] });
  expect(result.ok).toBe(false);
  expect(result.problems).toEqual(expect.arrayContaining([
    expect.stringContaining('Description: product.description'),
    expect.stringContaining('Applications: product_attribute_value.value'),
  ]));
});

test('checks representative values on the right records, rather than counts or unrelated attributes', () => {
  const good = { product: [{ description: 'Warm walnut with a weathered look.' }], product_attribute_value: applications };
  expect(report(good).ok).toBe(true);
  const wrongRelation = applications.map((row) => ({ ...row, attribute: { name: 'Size' } }));
  expect(report({ ...good, product_attribute_value: wrongRelation }).ok).toBe(false);
  expect(report({ ...good, product: [{ description: 'A product description exists.' }] }).problems)
    .toContain('Description: product.description: missing expected text "weathered look"');
});

test('an omitted standard product tab fails even when every declared expectation passes', () => {
  const result = report({ product: [{ description: 'weathered look' }] }, sections.slice(0, 1));
  expect(result.problems).toContain('Uninventoried tab "Applications" (#applications)');
});

test('exceptions require evidence and reasons; unsupported content cannot pass completion', () => {
  const shared: SectionContract = { name: 'Details', selector: '#details', status: 'shared-boilerplate',
    evidence: 'About our brand', reason: 'Identical brand introduction in both saved product templates.' };
  expect(report({}, [shared], '<div id="details">About our brand</div>').ok).toBe(true);
  expect(report({}, [{ ...shared, evidence: 'This text is absent' }], '<div id="details">About our brand</div>').ok).toBe(false);
  expect(report({}, [{ ...shared, status: 'unsupported' }], '<div id="details">About our brand</div>').ok).toBe(false);
  const { reason: _reason, ...unjustified } = shared;
  expect(FixtureSection.safeParse(unjustified).success).toBe(false);
  expect(FixtureSection.safeParse({ ...sections[0], expect: undefined }).success).toBe(false);
  expect(FixturePages.safeParse([{ type: 'product', file: 'page.html', sections: [shared] }]).success).toBe(false);
  expect(FixturePages.safeParse([{ type: 'product', file: 'page.html', sections: [sections[0], shared] }]).success).toBe(true);
  expect(FixturePages.safeParse([{ type: 'product', file: 'page.html', sections: [shared], typo: true }]).success).toBe(false);
});

test('empty and login-gated claims must agree with the selected fixture content', () => {
  const empty: SectionContract = { name: 'Downloads', selector: '#downloads', status: 'empty',
    evidence: 'No downloads in this template.', reason: 'The product download container is empty in this fixture.' };
  expect(report({}, [empty], '<div id="downloads"></div>').ok).toBe(true);
  expect(report({}, [empty], '<div id="downloads"><a href="guide.pdf">Guide</a></div>').ok).toBe(false);
  expect(report({}, [empty], '<div id="downloads"><img src="swatch.jpg"></div>').ok).toBe(false);
  const gated: SectionContract = { name: 'Price', selector: '#price', status: 'login-gated', evidence: 'Sign in to see prices',
    reason: 'Trade-account prices require authentication.' };
  expect(report({}, [gated], '<p id="price">Sign in to see prices</p>').ok).toBe(true);
  expect(report({}, [gated], '<p id="price">$12</p>').ok).toBe(false);
});

test('zero, false, and values beyond the first record are checked without treating them as absent', () => {
  const contract: SectionContract[] = [{ name: 'Stock', selector: '#stock', status: 'extracted', evidence: 'Out of stock',
    expect: [{ table: 'product_variant', field: 'stockQty', values: [0], minCount: 2 },
      { table: 'product_attribute_value', field: 'isAvailable', values: [false] }] }];
  const data = { product_variant: [{ stockQty: 3 }, { stockQty: 0 }], product_attribute_value: [{ isAvailable: false }] };
  expect(report(data, contract, '<p id="stock">Out of stock</p>').ok).toBe(true);
});
