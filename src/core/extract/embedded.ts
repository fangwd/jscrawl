import type { XDocument } from 'gumbo-html';

/**
 * The JSON value assigned after `marker` in an inline script, e.g.
 * embeddedJson(doc, 'window.__STATE__ =') for `window.__STATE__ = {...};`.
 * Occurrences not followed by an object or array, or not valid JSON, are
 * skipped; undefined when none qualifies.
 */
export function embeddedJson(doc: XDocument, marker: string): unknown {
  for (const script of doc.find('script')) {
    const value = jsonFragment(script.textContent, marker);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * The first balanced `{...}` or `[...]` in `text` that follows `marker` - or the
 * first one in `text` when no marker is given - parsed as JSON. Use it wherever
 * JSON is embedded in something that is not a script body: a Knockout
 * `data-bind` attribute (`jsonFragment(el.attr_s('data-bind'), 'data: {')`), a
 * config string, a template. Candidates that are not valid JSON are skipped;
 * undefined when none qualifies.
 *
 * The marker may end with the opening bracket (`'data: {'`) or stop before it
 * (`'window.x ='`). Attribute values and text nodes arrive with their character
 * references decoded; a script body does not, so `decodeEntities` it first when
 * its JSON carries references.
 */
export function jsonFragment(text: string, marker?: string): unknown {
  const starts: number[] = [];
  if (marker === undefined) {
    const at = text.search(/[[{]/);
    if (at !== -1) starts.push(at);
  } else {
    for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) {
      const start = bracketAt(text, at + marker.length - 1, at + marker.length);
      if (start !== -1) starts.push(start);
    }
  }
  for (const start of starts) {
    const end = closingBracket(text, start);
    if (end === -1) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // not JSON (e.g. a JavaScript object literal); try the next candidate
    }
  }
  return undefined;
}

/**
 * Where a marker's JSON starts: at `last` when the marker itself ends with an
 * opening bracket, else at the first non-space character after it. -1 when
 * neither is a bracket, so a marker followed by a scalar is skipped.
 */
function bracketAt(text: string, last: number, after: number): number {
  if (text[last] === '{' || text[last] === '[') return last;
  const offset = text.slice(after).search(/\S/);
  if (offset === -1) return -1;
  const at = after + offset;
  return text[at] === '{' || text[at] === '[' ? at : -1;
}

/** Index of the bracket closing the one at `start`, skipping JSON strings. */
export function closingBracket(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{' || c === '[') {
      depth++;
    } else if ((c === '}' || c === ']') && --depth === 0) {
      return i;
    }
  }
  return -1;
}
