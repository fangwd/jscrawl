export interface Price {
  amount: number;
  unit?: string;
}

/**
 * Parses display prices like "$1,234.50", "From $45", "$89.90 per m²" or
 * "$4.50/kg". Returns the first amount and the unit after it, if any.
 */
export function parsePrice(text: string): Price | null {
  const match = /(\d{1,3}(?:[,\s]\d{3})+|\d+)(\.\d+)?/.exec(text);
  if (!match) return null;
  const amount = parseFloat(match[1].replace(/[,\s]/g, '') + (match[2] ?? ''));
  const rest = text.slice(match.index + match[0].length);
  const unit = /^\s*(?:per\b|\/)\s*([a-z][a-z0-9²³]*)/i.exec(rest)?.[1];
  return unit
    ? { amount, unit: unit.toLowerCase().replace('²', '2').replace('³', '3') }
    : { amount };
}
