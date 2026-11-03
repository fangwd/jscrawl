import type { XDocument } from 'gumbo-html';

export type JsonLdNode = { '@type'?: string | string[]; [key: string]: any };

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
