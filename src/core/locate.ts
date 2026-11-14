// Where the values read off a rendered page live in its source: a saved JSON
// response, embedded state, JSON-LD, an attribute or the DOM - the step between
// "the page shows this name and this price" and writing the extraction. Plain
// matching, no model: a value is found where a source holds the same text, or
// the same amount however it is formatted.

import { parse, XDocument, XElement } from 'gumbo-html';

import { closingBracket, jsonLd } from './extract';

export type LocationSource = 'json' | 'embedded' | 'json-ld' | 'attribute' | 'dom';

export interface Location {
  source: LocationSource;
  /** A JSON path, or a CSS selector (with `[attr]` for an attribute). */
  where: string;
  /** The file, script or selector count that qualifies `where`. */
  of?: string;
  /** What the source holds there, as it holds it. */
  found: string;
  /** How it differs from what was asked for: an amount in cents, a text that only contains it. */
  note?: string;
}

/** Cheapest first: what a crawler should prefer when a value is in several places. */
const ORDER: LocationSource[] = ['json', 'embedded', 'json-ld', 'attribute', 'dom'];
const PER_SOURCE = 3;
const ATTRIBUTES = /\s(content|value|alt|title|data-[\w-]+)=(?:"([^"]*)"|'([^']*)')/g;
const SKIPPED_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'head',
  'html',
  'body',
]);

/** Utility classes (tailwind and the like) describe looks, not content: a selector built on them matches half the page. */
const UTILITY_CLASS =
  /^(flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|static|container|truncate|italic|uppercase|lowercase|capitalize|underline|sr-only|group|peer|[a-z]{1,2}-\d.*|(w|h|p|m|z|gap|top|left|right|bottom|inset|min|max|text|font|bg|border|rounded|shadow|items|justify|content|self|place|order|col|row|space|leading|tracking|overflow|opacity|cursor|transition|duration|ease|whitespace|break|align|object|aspect|basis|grow|shrink|float|clear|flex|grid|block|inline|sm|md|lg|xl|2xl|hover|focus|d|py|px|pt|pb|pl|pr|my|mx|mt|mb|ml|mr)-.+)$/;

const norm = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The amount a short text states ("$1,234.50", "1234.5 AUD", "From $850", "850");
 * undefined when it is not one amount. A number among letters ("WD-120", "2 seats")
 * is a code or a count unless a currency sign or code says otherwise.
 */
export function amountOf(text: string): number | undefined {
  const trimmed = text.trim();
  const numbers = trimmed.length > 24 ? [] : (trimmed.match(/\d[\d,]*(?:\.\d+)?/g) ?? []);
  // "12 x 30" and "2-4 weeks" state two numbers, not an amount
  const rest = numbers.length === 1 ? trimmed.replace(numbers[0], '').trim() : '';
  const money = rest === '' || /[$€£¥₹]/.test(rest) || /^[A-Z]{3}$/.test(rest);
  const amount = numbers.length === 1 && money ? Number(numbers[0].replace(/,/g, '')) : NaN;
  return Number.isFinite(amount) ? amount : undefined;
}

type Match = { note?: string } | null;

/** How a source value matches a wanted one: as the same text, or the same amount. */
function matcher(wanted: string): (candidate: unknown) => Match {
  const text = norm(wanted);
  const amount = amountOf(wanted);
  return (candidate) => {
    if (typeof candidate === 'number') {
      if (amount === undefined) return null;
      if (candidate === amount) return {};
      return amount !== 0 && candidate === Math.round(amount * 100) ? { note: 'in cents' } : null;
    }
    if (typeof candidate !== 'string') return null;
    if (norm(candidate) === text) return {};
    return amount !== undefined && amountOf(candidate) === amount
      ? { note: 'same amount, formatted differently' }
      : null;
  };
}

function walkJson(
  value: unknown,
  path: string,
  visit: (leaf: string | number, path: string) => void,
): void {
  if (typeof value === 'string' || typeof value === 'number') visit(value, path);
  else if (Array.isArray(value))
    value.forEach((item, i) => walkJson(item, path ? `${path}.${i}` : String(i), visit));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value))
      walkJson(item, path ? `${path}.${key}` : key, visit);
  }
}

/** The JSON an inline script carries, and how jscrawl_html's `json` names it; undefined when it carries none. */
function scriptJson(script: XElement, index: number): { spec: string; value: unknown } | undefined {
  const text = script.textContent ?? '';
  if (/ld\+json/i.test(script.attr('type') ?? '')) return undefined;
  const assign = /(?:window|globalThis)\.([A-Za-z_$][\w.$]*)\s*=\s*[{[]/.exec(text);
  const start = /^\s*[{[]/.test(text)
    ? text.search(/\S/)
    : assign
      ? assign.index + assign[0].length - 1
      : -1;
  if (start === -1) return undefined;
  const end = closingBracket(text, start);
  if (end === -1) return undefined;
  try {
    const id = script.attr('id');
    return {
      spec:
        assign && start !== text.search(/\S/)
          ? `window.${assign[1]} =`
          : id
            ? `#${id}`
            : `[${index + 1}]`,
      value: JSON.parse(text.slice(start, end + 1)),
    };
  } catch {
    return undefined;
  }
}

/** A selector for an element from its own tag, id and classes and up to two ancestors'. */
function selectorOf(element: XElement): string {
  const parts: string[] = [];
  for (
    let node: XElement | null = element;
    node && node.tagName && parts.length < 3;
    node = node.parent
  ) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') break;
    const id = node.attr('id');
    // a generated id (digits, a hash) names one page's element, not the template's
    if (id && /^[A-Za-z][\w-]*$/.test(id) && !/\d{3,}/.test(id)) {
      parts.unshift(`${tag}#${id}`);
      break;
    }
    const classes = (node.attr('class') ?? '')
      .split(/\s+/)
      .filter(
        (name) =>
          /^[A-Za-z_][\w-]*$/.test(name) && !/\d{4,}/.test(name) && !UTILITY_CLASS.test(name),
      );
    parts.unshift(
      tag +
        classes
          .slice(0, 2)
          .map((name) => `.${name}`)
          .join(''),
    );
  }
  return parts.join(' > ');
}

function domLocations(
  doc: XDocument,
  wanted: string,
  matches: (candidate: unknown) => Match,
): Location[] {
  const text = norm(wanted);
  const exact: Location[] = [];
  const containing: Location[] = [];
  const add = (list: Location[], element: XElement, note?: string) => {
    const where = selectorOf(element);
    if (list.some((location) => location.where === where)) return;
    const count = doc.count(where);
    list.push({
      source: 'dom',
      where,
      of: count === 1 ? 'the only match' : `${count} matches on the page`,
      found: element.text({ normalize: true }).slice(0, 120),
      ...(note ? { note } : {}),
    });
  };
  for (const element of doc.find('body *')) {
    if (!element.tagName || SKIPPED_TAGS.has(element.tagName.toLowerCase())) continue;
    const own = element.text({ normalize: true });
    if (!own || own.length > text.length + 200) continue;
    const match = matches(own);
    const contains = !match && text.length >= 8 && norm(own).includes(text);
    if (!match && !contains) continue;
    // the deepest element that holds it: a wrapper with the same text is not where it lives
    const deeper = element.children().some((child) => {
      const inner = child.text({ normalize: true });
      return matches(inner) !== null || (contains && norm(inner).includes(text));
    });
    if (deeper) continue;
    if (match) add(exact, element, match.note);
    else add(containing, element, 'the text contains it');
  }
  return exact.length ? exact : containing;
}

function attributeLocations(
  html: string,
  doc: XDocument,
  matches: (candidate: unknown) => Match,
): Location[] {
  const locations: Location[] = [];
  for (const tag of html.matchAll(/<([a-z][\w-]*)\b([^<>]*)>/gi)) {
    const name = tag[1].toLowerCase();
    if (name === 'script' || name === 'style') continue;
    for (const attr of tag[2].matchAll(ATTRIBUTES)) {
      const value = attr[2] ?? attr[3] ?? '';
      const match = value ? matches(value) : null;
      if (!match) continue;
      const key = /\s(?:name|property|itemprop)=["']([^"']+)["']/i.exec(tag[2])?.[1];
      const id = /\sid=["']([A-Za-z][\w-]*)["']/.exec(tag[2])?.[1];
      const cls = /\sclass=["']([^"']+)["']/
        .exec(tag[2])?.[1]
        .split(/\s+/)
        .filter((c) => /^[A-Za-z_][\w-]*$/.test(c))[0];
      const base =
        name === 'meta' && key
          ? `meta[${/og:|:/.test(key) ? 'property' : 'name'}="${key}"]`
          : `${name}${id ? `#${id}` : cls ? `.${cls}` : key ? `[itemprop="${key}"]` : ''}`;
      const where = `${base}[${attr[1]}]`;
      if (locations.some((location) => location.where === where)) continue;
      const count = doc.count(base);
      locations.push({
        source: 'attribute',
        where,
        of: count === 1 ? 'the only match' : `${count} matches on the page`,
        found: value.slice(0, 120),
        ...(match.note ? { note: match.note } : {}),
      });
    }
  }
  return locations;
}

/**
 * Where each wanted value lives in a page's html and in the JSON responses
 * saved beside it, cheapest source first; a value found nowhere maps to none.
 */
export function locateValues(
  html: string,
  baseUrl: string,
  values: Record<string, string>,
  json: { name: string; body: string }[] = [],
): Record<string, Location[]> {
  const doc = parse(html, { baseUrl });
  const sources: { source: LocationSource; of?: string; value: unknown }[] = [];
  for (const file of json) {
    try {
      sources.push({
        source: 'json',
        of: file.name,
        value: JSON.parse(file.body),
      });
    } catch {
      // not JSON: nothing to locate in it
    }
  }
  doc
    .find('script')
    .filter((script) => !script.attr('src'))
    .forEach((script, index) => {
      const found = scriptJson(script, index);
      if (found)
        sources.push({
          source: 'embedded',
          of: found.spec,
          value: found.value,
        });
    });
  jsonLd(doc).forEach((node) =>
    sources.push({
      source: 'json-ld',
      of: String(node['@type'] ?? 'node'),
      value: node,
    }),
  );

  const located: Record<string, Location[]> = {};
  for (const [field, wanted] of Object.entries(values)) {
    if (!wanted.trim()) continue;
    const matches = matcher(wanted);
    const locations: Location[] = [];
    for (const { source, of, value } of sources) {
      // one location per path shape: the items of an array hold it at the same place
      const shapes = new Map<string, Location & { repeats: number }>();
      walkJson(value, '', (leaf, path) => {
        const match = matches(leaf);
        if (!match) return;
        const shape = path.replace(/(^|\.)\d+(?=\.|$)/g, '$1*');
        const known = shapes.get(shape);
        if (known) known.repeats += 1;
        else
          shapes.set(shape, {
            source,
            where: path,
            of,
            found: String(leaf).slice(0, 120),
            ...(match.note ? { note: match.note } : {}),
            repeats: 0,
          });
      });
      for (const { repeats, ...location } of [...shapes.values()].slice(0, PER_SOURCE)) {
        const more = repeats ? `and ${repeats} more at the same path of other items` : undefined;
        locations.push({
          ...location,
          ...(more ? { note: [location.note, more].filter(Boolean).join('; ') } : {}),
        });
      }
    }
    locations.push(...attributeLocations(html, doc, matches).slice(0, PER_SOURCE));
    locations.push(...domLocations(doc, wanted, matches).slice(0, PER_SOURCE));
    located[field] = locations.sort((a, b) => ORDER.indexOf(a.source) - ORDER.indexOf(b.source));
  }
  return located;
}

export function renderLocations(
  values: Record<string, string>,
  located: Record<string, Location[]>,
): string {
  const lines: string[] = [];
  const missing: string[] = [];
  for (const [field, wanted] of Object.entries(values)) {
    const locations = located[field] ?? [];
    lines.push(`${field}: "${wanted}"`);
    if (locations.length === 0) {
      missing.push(field);
      lines.push('  not found');
      continue;
    }
    for (const location of locations) {
      const of = location.of ? ` (${location.of})` : '';
      const note = location.note ? ` - ${location.note}` : '';
      const same =
        norm(location.found) === norm(wanted) ? '' : ` = ${JSON.stringify(location.found)}`;
      lines.push(`  ${location.source.padEnd(9)} ${location.where}${of}${same}${note}`);
    }
  }
  const sourcesHit = new Map<string, number>();
  for (const locations of Object.values(located)) {
    for (const key of new Set(
      locations.map((l) =>
        l.source === 'dom' || l.source === 'attribute'
          ? l.source
          : `${l.source} ${l.of ?? ''}`.trim(),
      ),
    )) {
      sourcesHit.set(key, (sourcesHit.get(key) ?? 0) + 1);
    }
  }
  const total = Object.keys(values).length;
  lines.push(
    `sources by values carried, of ${total}: ` +
      ([...sourcesHit]
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => `${key} ${count}`)
        .join(', ') || 'none'),
  );
  if (missing.length) {
    lines.push(
      `not found: ${missing.join(', ')} - check the value is typed as the page shows it; otherwise it arrives after load ` +
        '(a call jscrawl_pageProbe lists: save it with jscrawl_webfetch and pass it in json), is built by script, or is part of an image',
    );
  }
  lines.push(
    'Sources are listed cheapest first: a saved JSON response, embedded state (read it with jscrawl_html json: the name in ' +
      'brackets), JSON-LD, an attribute, the DOM. A selector matching more than one element needs its container. One page ' +
      'proves a location for that page: confirm it on a second page of the type before relying on it.',
  );
  return lines.join('\n');
}
