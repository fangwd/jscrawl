import { parse } from 'gumbo-html';
import type { XDocument, XElement } from 'gumbo-html';

export interface SpecPair {
  name: string;
  value: string;
}

export interface SpecSection {
  title: string | null;
  pairs: SpecPair[];
}

/**
 * The sections of a spec table: single-cell rows spanning the table (the
 * `<td colspan="2">` headings of pasted supplier tables) start a new section;
 * th/td and two-td rows become its pairs, other row shapes (column-header and
 * comparison rows) are skipped. A table without headings is one section with
 * a null title. Use this for pasted/sectioned tables and specPairs for
 * uniform ones; both understand th/td and td/td rows.
 */
export function specSections(table: XElement): SpecSection[] {
  const sections: SpecSection[] = [];
  let current: SpecSection = { title: null, pairs: [] };
  sections.push(current);
  const add = (name?: XElement | null, value?: XElement | null) => {
    const pair = {
      name: name?.text({ normalize: true }).replace(/:$/, '').trim() ?? '',
      value: value?.text({ normalize: true }) ?? '',
    };
    if (pair.name && pair.value) current.pairs.push(pair);
  };
  for (const tr of table.find('tr')) {
    const ths = tr.children('th');
    const tds = tr.children('td');
    if (ths.length === 0 && tds.length === 1) {
      const title = tds[0].text({ normalize: true });
      if (title) {
        current = { title, pairs: [] };
        sections.push(current);
      }
      continue;
    }
    if (ths.length >= 1 && tds.length >= 1) add(ths[0], tds[0]);
    else if (ths.length === 0 && tds.length === 2) add(tds[0], tds[1]);
  }
  return sections.filter((section) => section.pairs.length > 0);
}

/**
 * Name/value pairs under `root`: table rows (th/td or td/td) and dt/dd lists
 * by default, or rows matched by custom selectors (e.g. WooCommerce's
 * label/value divs). Whitespace is normalized and empty pairs are dropped.
 */
export function specPairs(
  root: XElement | XDocument,
  selectors?: { row: string; name: string; value: string },
): SpecPair[] {
  const pairs: SpecPair[] = [];
  const add = (name?: XElement | null, value?: XElement | null) => {
    const pair = {
      name: name?.text({ normalize: true }).replace(/:$/, '').trim() ?? '',
      value: value?.text({ normalize: true }) ?? '',
    };
    if (pair.name && pair.value) pairs.push(pair);
  };
  if (selectors) {
    for (const row of root.find(selectors.row)) {
      add(row.first(selectors.name), row.first(selectors.value));
    }
    return pairs;
  }
  for (const tr of root.find('tr')) {
    const th = tr.first('th');
    if (th) {
      add(th, tr.first('td'));
    } else {
      const tds = tr.find('td');
      if (tds.length === 2) add(tds[0], tds[1]);
    }
  }
  for (const dt of root.find('dt')) {
    add(dt, dt.next('dd'));
  }
  return pairs;
}

/**
 * The best source of an <img>: the largest srcset candidate, then lazy-load
 * attributes, then src. Placeholder data: URIs are skipped. Relative urls are
 * returned as-is; the domain's write methods must resolve them against the page.
 */
export function imageUrl(img: XElement): string | undefined {
  for (const name of ['srcset', 'data-srcset']) {
    const best = largestCandidate(img.attr(name));
    if (best) return best;
  }
  for (const name of ['data-src', 'data-lazy-src', 'data-original', 'src']) {
    const value = img.attr(name)?.trim();
    if (value && !value.startsWith('data:')) return value;
  }
  return undefined;
}

function largestCandidate(srcset?: string): string | undefined {
  let best: { url: string; size: number } | undefined;
  for (const candidate of (srcset ?? '').split(/,\s+/)) {
    const [url, descriptor = '1x'] = candidate.trim().split(/\s+/);
    if (!url || url.startsWith('data:')) continue;
    const size = parseFloat(descriptor) || 1;
    if (!best || size > best.size) best = { url, size };
  }
  return best?.url;
}

/** The text a reader sees in `element` - its `innerText` - on one line. */
export function visibleText(element: XElement): string {
  return element.innerText.replace(/\s+/g, ' ').trim();
}

/** The text a reader sees in an HTML fragment, such as a product JSON's description: one line per block. */
export function htmlText(html: string): string {
  return parse(html).first('body')?.innerText ?? '';
}
