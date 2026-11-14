const NAMED_ENTITIES: { [name: string]: string } = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

/**
 * Decodes HTML character references in one pass, so `&amp;quot;` yields
 * `&quot;` and not `"`: a reference that decodes to an ampersand is not decoded
 * again. Unknown named references are left as they are.
 *
 * The parser already decodes text nodes and attribute values (`text()`,
 * `attr()`), so this is only for raw text it leaves alone - a `<script>` body,
 * where character references are not decoded - or for a source that escaped
 * twice. Never decode a value the parser handed you.
 */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (reference, entity: string) => {
      if (entity[0] !== '#') return NAMED_ENTITIES[entity.toLowerCase()] ?? reference;
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : reference;
    },
  );
}
