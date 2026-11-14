// Saved test pages listed in crawlers/fixtures/<site>/pages.json. Each entry
// has a type, file, optional URL and any domain-specific fields. The fixture
// harness runs each page through the crawler and checks the domain's contract.

import { z } from 'zod';

import { crawledUrlTypes, domain } from './domain';

/** One listed test page: the core's fields, plus the domain's. */
export interface FixtureEntry {
  type: string;
  file: string;
  url?: string;
  [extra: string]: unknown;
}

const text = z.string().trim().min(1);

/** The schema of `pages.json`: strict, so a misspelt field is an error rather than a silently ignored contract. */
export function fixturePages(): z.ZodType<FixtureEntry[]> {
  const entry = z
    .object({
      type: text.refine((type) => crawledUrlTypes().includes(type), {
        message: `page type must be one of ${crawledUrlTypes().join(', ')}`,
      }),
      file: text,
      url: text.optional(),
      ...(domain().fixtures?.entry ?? {}),
    })
    .strict();
  return z.array(entry).min(1) as unknown as z.ZodType<FixtureEntry[]>;
}

/** What the domain finds wrong with a listing before any page runs; nothing for a domain without a contract. */
export function fixtureContracts(pages: FixtureEntry[]): string[] {
  return domain().fixtures?.contracts?.(pages) ?? [];
}
