// A fixture's section inventory and assertions over the full extraction buffer.
// Record counts alone cannot establish that the information on a page survived.
import { Record as SqlRecord } from 'sqlex';
import { XDocument, XElement } from 'gumbo-html';
import { z } from 'zod';

const text = z.string().trim().min(1);
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const fieldPath = text.refine(
  (value) => value.split('.').every((part) => part && !['__proto__', 'prototype', 'constructor'].includes(part)),
  'Use a dotted field path without prototype properties'
);

export const FixtureExpectation = z.object({
  table: text,
  field: fieldPath,
  where: z.record(fieldPath, scalar).optional(),
  minCount: z.number().int().positive().optional(),
  contains: z.array(text).min(1).optional(),
  values: z.array(scalar).min(1).optional(),
}).strict();

export const FixtureSection = z.object({
  name: text,
  selector: text,
  attr: text.optional(),
  status: z.enum(['extracted', 'empty', 'login-gated', 'shared-boilerplate', 'unsupported']),
  // A short excerpt from the selected source, or an absence explanation for empty.
  evidence: text,
  reason: text.optional(),
  expect: z.array(FixtureExpectation).min(1).optional(),
}).strict().superRefine((section, ctx) => {
  if (section.status === 'extracted' && !section.expect?.length) {
    ctx.addIssue({ code: 'custom', path: ['expect'], message: 'An extracted section needs saved-field expectations' });
  }
  if (section.status !== 'extracted' && !section.reason) {
    ctx.addIssue({ code: 'custom', path: ['reason'], message: 'An exception needs a reason supported by fixture evidence' });
  }
  if (section.status !== 'extracted' && section.expect) {
    ctx.addIssue({ code: 'custom', path: ['expect'], message: 'Only extracted sections have saved-field expectations' });
  }
});

export type SectionContract = z.infer<typeof FixtureSection>;

export const FixturePage = z.object({
  type: z.enum(['seed', 'category', 'product']),
  file: text,
  url: text.optional(),
  sections: z.array(FixtureSection).min(1).optional(),
}).strict().superRefine((page, ctx) => {
  if (page.type === 'product' && page.sections && !page.sections.some((section) => section.status === 'extracted')) {
    ctx.addIssue({ code: 'custom', path: ['sections'], message: 'A product inventory needs at least one extracted section with saved-field expectations' });
  }
});

export const FixturePages = z.array(FixturePage).min(1);

export interface CompletenessReport {
  ok: boolean;
  sections: { name: string; status: SectionContract['status']; matches: number; assertions: number }[];
  problems: string[];
}

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
const same = (left: unknown, right: unknown) =>
  typeof left === 'string' && typeof right === 'string' ? normalize(left) === normalize(right) : left === right;
const nonempty = (value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return normalize(value).length > 0;
  if (Array.isArray(value)) return value.some(nonempty);
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true; // zero and false are values too
};

function field(record: unknown, path: string): unknown {
  let value: any = record;
  for (const part of path.split('.')) {
    if (['__proto__', 'prototype', 'constructor'].includes(part) || value == null) return undefined;
    if (value instanceof SqlRecord) {
      try { value = value.get(part); } catch { return undefined; }
    } else {
      value = Object.prototype.hasOwnProperty.call(value, part) ? value[part] : undefined;
    }
  }
  return value;
}

/** A matched block inventories any tab panels enclosing it, including hidden tabs. */
function coverPanels(element: XElement, covered: Set<string>) {
  for (let parent: XElement | null = element; parent; parent = parent.parent) {
    const id = parent.attr('id');
    if (id && parent.attr('role') === 'tabpanel') covered.add(id);
  }
}

/** Uses full buffered records, independently of preview limits and table filters. */
export function checkCompleteness(
  doc: XDocument,
  sections: SectionContract[],
  records: (table: string) => unknown[]
): CompletenessReport {
  const report: CompletenessReport = { ok: true, sections: [], problems: [] };
  const covered = new Set<string>();
  const names = new Set<string>();
  for (const section of sections) {
    const problem = (message: string) => report.problems.push(`${section.name}: ${message}`);
    if (names.has(section.name.toLowerCase())) problem('duplicate section name');
    names.add(section.name.toLowerCase());
    let matches: XElement[] = [];
    try { matches = doc.find(section.selector); }
    catch { problem(`invalid source selector ${JSON.stringify(section.selector)}`); }
    matches.forEach((element) => coverPanels(element, covered));
    const source = normalize(matches.map((element) => section.attr
      ? element.attr(section.attr) ?? ''
      : element.text({ normalize: true })).join(' '));
    report.sections.push({ name: section.name, status: section.status, matches: matches.length, assertions: section.expect?.length ?? 0 });
    if (section.status === 'empty') {
      const media = !section.attr && matches.some((element) =>
        !!element.attr('src') || !!element.attr('href') || element.exists('img[src]') || element.exists('a[href]'));
      if (source || media) problem('declared empty, but the selected source contains content');
      continue;
    }
    if (!source) problem(`source ${JSON.stringify(section.selector)} has no content`);
    else if (!source.toLowerCase().includes(normalize(section.evidence).toLowerCase())) {
      problem('evidence excerpt does not occur in the selected source');
    }
    if (section.status === 'unsupported') {
      problem(`unsupported section keeps the crawler incomplete: ${section.reason}`);
    }
    if (section.status !== 'extracted') continue;
    for (const expected of section.expect ?? []) {
      let rows: unknown[];
      try { rows = records(expected.table); }
      catch { problem(`unknown extraction table ${expected.table}`); continue; }
      rows = rows.filter((row) => Object.entries(expected.where ?? {}).every(([path, value]) => same(field(row, path), value)));
      const values = rows.flatMap((row) => {
        const value = field(row, expected.field);
        return Array.isArray(value) ? value : [value];
      }).filter(nonempty);
      const target = `${expected.table}.${expected.field}`;
      if (values.length < (expected.minCount ?? 1)) {
        problem(`${target}: expected at least ${expected.minCount ?? 1} nonempty value(s), got ${values.length}`);
      }
      for (const value of expected.values ?? []) {
        if (!values.some((actual) => same(actual, value))) problem(`${target}: missing expected value ${JSON.stringify(value)}`);
      }
      for (const snippet of expected.contains ?? []) {
        if (!values.some((value) => typeof value === 'string' && normalize(value).toLowerCase().includes(normalize(snippet).toLowerCase()))) {
          problem(`${target}: missing expected text ${JSON.stringify(snippet)}`);
        }
      }
    }
  }
  // Standard HTML tabs give us a discoverable inventory independently of the
  // agent's claims. Other section layouts still need a human/agent inventory.
  const labels = new Map(doc.find('[role="tab"]').map((tab) => [tab.attr('aria-controls'), normalize(tab.text({ normalize: true }))]));
  for (const panel of doc.find('[role="tabpanel"][id]')) {
    const id = panel.attr('id')!;
    if (!covered.has(id)) report.problems.push(`Uninventoried tab ${JSON.stringify(labels.get(id) || id)} (#${id})`);
  }
  report.ok = report.problems.length === 0;
  return report;
}
