// A site before it has a crawler: what its sitemaps list and what its home
// page links to, grouped by url shape with counts and samples. One call gives
// the size estimate, the shapes a url classifier must decide, and urls of each
// shape to look at - without putting thousands of urls in the agent's context.

import { parse } from 'gumbo-html';

import { coverageKey, urlShape } from './coverage';
import { detectFramework } from './pageprobe';
import { Fetcher, MAX_FILES, sitemapInventory } from './sitemap';

const SHAPES = 12;
const SAMPLES = 3;
const ROBOTS_RULES = 15;

export interface SurveyShape {
  shape: string;
  count: number;
  /** Full urls spread over the group: its first, middle and last members. */
  samples: string[];
}

export interface SiteSurvey {
  /** What robots.txt closes to every crawler: its `*` group's Disallow and Crawl-delay lines. Null when the site serves none. */
  robots: { rules: string[]; more: number } | null;
  sitemaps: { url: string; urls: number; shapes: SurveyShape[] }[];
  /** The site has more sitemap files than were read: the counts are a lower bound. */
  truncated: boolean;
  /** Distinct urls the sitemaps list, and their shapes. */
  listed: { urls: number; shapes: SurveyShape[] };
  home: {
    url: string;
    /** The frameworks and platforms its html gives away: what decides whether a shared profile fits. */
    platform: string[];
    /** The site's own pages the home page links to. */
    links: { urls: number; shapes: SurveyShape[] };
    /** Those inside its header or a nav element: the menu. */
    menu: { urls: number; shapes: SurveyShape[] };
    /** Shapes the home page links to and no sitemap lists. */
    unlisted: string[];
  } | null;
}

/** Biggest-first groups of urls by shape, each with samples spread over the group. */
export function shapeGroups(urls: string[], limit = SHAPES): SurveyShape[] {
  const groups = new Map<string, string[]>();
  for (const url of urls) {
    const shape = urlShape(url);
    const members = groups.get(shape);
    if (members) members.push(url);
    else groups.set(shape, [url]);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, limit)
    .map(([shape, members]) => ({
      shape,
      count: members.length,
      samples: spread(members, SAMPLES),
    }));
}

/** Up to `n` members from across a list, so samples are not all one section's. */
export function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))]);
}

/** The Disallow and Crawl-delay lines of the group that addresses every crawler. */
function robotsRules(text: string): string[] {
  const rules: string[] = [];
  let agents: string[] = [];
  let inRules = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    const [, field, value] = /^([\w-]+)\s*:\s*(.*)$/.exec(line) ?? [];
    if (!field) continue;
    if (/^user-agent$/i.test(field)) {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value);
    } else {
      inRules = true;
      if (agents.includes('*') && /^(disallow|crawl-delay)$/i.test(field) && value)
        rules.push(`${field} ${value}`);
    }
  }
  return rules;
}

function distinct(urls: string[]): string[] {
  const seen = new Map<string, string>();
  for (const url of urls) {
    const key = coverageKey(url);
    if (key && !seen.has(key)) seen.set(key, url);
  }
  return [...seen.values()];
}

/** Surveys the site `url` is on. A sitemap or page that cannot be fetched is left out, not an error. */
export async function surveySite(url: string, fetch: Fetcher): Promise<SiteSurvey> {
  const origin = new URL(url).origin;
  const host = new URL(url).hostname.replace(/^www\./, '');
  const robots = await fetch(`${origin}/robots.txt`)
    .then((text) => (/<html/i.test(text) ? null : robotsRules(text)))
    .catch(() => null);
  const { files, truncated } = await sitemapInventory(url, fetch);
  const listed = distinct(files.flatMap((file) => file.urls));

  let home: SiteSurvey['home'] = null;
  const html = await fetch(url).catch(() => null);
  if (html) {
    const doc = parse(html, { baseUrl: url });
    const own = (href: string | undefined): href is string =>
      !!href &&
      URL.canParse(href) &&
      /^https?:$/.test(new URL(href).protocol) &&
      new URL(href).hostname.replace(/^www\./, '') === host;
    const links = distinct(
      doc
        .links()
        .map((link) => link.href)
        .filter(own),
    );
    const menu = distinct(
      [...doc.find('header a[href]'), ...doc.find('nav a[href]')]
        .map((a) => a.urlAttr('href'))
        .filter(own),
    );
    const listedShapes = new Set(listed.map(urlShape));
    home = {
      url,
      platform: detectFramework(html),
      links: { urls: links.length, shapes: shapeGroups(links) },
      menu: { urls: menu.length, shapes: shapeGroups(menu) },
      unlisted: files.length
        ? [...new Set(links.map(urlShape))].filter((shape) => !listedShapes.has(shape))
        : [],
    };
  }
  return {
    robots: robots && {
      rules: robots.slice(0, ROBOTS_RULES),
      more: Math.max(0, robots.length - ROBOTS_RULES),
    },
    truncated,
    sitemaps: files.map((file) => ({
      url: file.url,
      urls: file.urls.length,
      shapes: shapeGroups(file.urls, 4),
    })),
    listed: { urls: listed.length, shapes: shapeGroups(listed) },
    home,
  };
}

export function renderSurvey(survey: SiteSurvey): string {
  const lines: string[] = [];
  const shapes = (groups: SurveyShape[], indent: string) => {
    for (const group of groups) {
      lines.push(`${indent}${group.shape.padEnd(24)} ${String(group.count).padStart(7)}`);
      for (const sample of group.samples) lines.push(`${indent}    ${sample}`);
    }
  };
  if (!survey.robots) lines.push('robots.txt: none served');
  else if (survey.robots.rules.length === 0)
    lines.push('robots.txt: closes nothing to every crawler');
  else {
    const more = survey.robots.more ? `, and ${survey.robots.more} more rules` : '';
    lines.push(`robots.txt, for every crawler: ${survey.robots.rules.join(', ')}${more}`);
  }
  if (survey.sitemaps.length === 0) {
    lines.push(
      'sitemaps: none found (no robots.txt Sitemap: line, no /sitemap.xml) - discovery has to come from listings and the menu',
    );
  } else {
    lines.push(`sitemaps: ${survey.sitemaps.length} files, ${survey.listed.urls} distinct urls`);
    if (survey.truncated) {
      lines.push(
        `  only the first ${MAX_FILES} sitemap files were read: the site lists more urls than this, so the counts are a lower bound`,
      );
    }
    for (const file of survey.sitemaps) {
      lines.push(
        `  ${file.url}: ${file.urls} urls - ${file.shapes.map((group) => `${group.shape} ${group.count}`).join(', ') || 'empty'}`,
      );
    }
    lines.push('listed urls by shape (count, then sample urls):');
    shapes(survey.listed.shapes, '  ');
  }
  if (!survey.home) {
    lines.push('home page: could not be fetched as html - probe it with jscrawl_pageRead');
  } else {
    lines.push(
      `platform: ${survey.home.platform.length ? survey.home.platform.join(', ') : '(none detected in the home page)'}`,
    );
    lines.push(
      `home page ${survey.home.url}: links to ${survey.home.links.urls} of the site's pages`,
    );
    if (survey.home.links.urls === 0) {
      lines.push(
        '  no links in the html the server sent: the page is rendered by script or the request was refused - read it with jscrawl_pageRead',
      );
    }
    shapes(survey.home.links.shapes, '  ');
    lines.push(`its menu (header and nav links): ${survey.home.menu.urls} pages`);
    shapes(survey.home.menu.shapes, '  ');
    if (survey.home.unlisted.length)
      lines.push(`shapes it links to that no sitemap lists: ${survey.home.unlisted.join(', ')}`);
  }
  lines.push(
    'A shape is the first path segment, with * for each deeper one and <slug> for a single segment. Read one sample of ' +
      'each shape that could carry a record with jscrawl_pageRead before writing urlType(); two kinds of page can share one shape.',
  );
  return lines.join('\n');
}
