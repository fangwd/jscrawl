import type { XDocument } from 'gumbo-html';

import { findType, jsonLd } from './jsonld';

export interface Breadcrumb {
  name: string;
  url?: string;
}

/**
 * The page's breadcrumb trail, from a JSON-LD BreadcrumbList when present,
 * otherwise from the elements matching `selector` (one per crumb; the link is
 * the element itself or its first <a>).
 */
export function breadcrumbs(doc: XDocument, selector?: string): Breadcrumb[] {
  const [list] = findType(jsonLd(doc), 'BreadcrumbList');
  if (list) {
    const items = [...(list.itemListElement ?? [])].sort(
      (a, b) => (a.position ?? 0) - (b.position ?? 0),
    );
    return items
      .map((entry) => {
        const item = entry.item;
        const url = typeof item === 'string' ? item : (item?.['@id'] ?? item?.url ?? entry.url);
        const name = String(entry.name ?? item?.name ?? '').trim();
        return { name, ...(url ? { url: String(url) } : {}) };
      })
      .filter((crumb) => crumb.name);
  }
  if (!selector) return [];
  return doc
    .find(selector)
    .map((el) => {
      const link = el.tagName === 'a' ? el : el.first('a');
      const url = link?.urlAttr('href');
      return { name: el.text({ normalize: true }), ...(url ? { url } : {}) };
    })
    .filter((crumb) => crumb.name);
}
