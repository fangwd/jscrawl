// A headless devtools session: loads a page in a real browser and reports what
// an engineer checks first - the JSON the page fetches over the network, the
// inline scripts that carry embedded state, framework hints, JSON-LD types and
// raw-vs-rendered size - so an extraction strategy can target the cheapest
// reliable source instead of guessing DOM selectors.

import type { Browser } from 'puppeteer';
import { REQUEST_HEADERS } from './base-crawler';
import { browserProxyArgs } from './puppet';
import { closingBracket } from './extract/embedded';
import { jsonLd } from './extract';
import { parse } from 'gumbo-html';
import { sleep } from './utils';

export interface ProbeNetworkEntry {
  method: string;
  url: string;
  requestBody?: string;
  /** The request headers a replay may need: the page's own, not the browser's standard set or cookies. */
  requestHeaders: { [name: string]: string };
  status: number;
  contentType: string;
  bytes: number;
  body: string;
  /** How many of the page's visible text lines appear in the body. */
  pageTextHits: number;
  /** JSON paths ("menu.categories.*.items.*.name") holding those texts, most hits first, with counts. */
  pageTextPaths: string[];
}

export interface ProbeScript {
  marker: string;
  parses: boolean;
  bytes: number;
  preview: string;
  pageTextHits: number;
}

export interface ProbeReport {
  document: {
    status: number;
    finalUrl: string;
    contentType: string;
    rawBytes: number;
    renderedBytes: number;
    title: string;
    /** Distinct visible text lines sampled from the rendered page; the denominator of pageTextHits. */
    pageTexts: number;
  };
  framework: string[];
  jsonLdTypes: string[];
  embeddedScripts: ProbeScript[];
  network: ProbeNetworkEntry[];
  /** With `interact`: the option pickers changed, and what the page fetched in response. */
  interactions?: { pickers: string[]; network: ProbeNetworkEntry[] };
  /** The page's html as the browser rendered it, before any picker was changed. */
  rendered: string;
}

export interface ProbeOptions {
  timeoutMs?: number;
  /** Choose another value in each option picker, as a shopper would, and record what that fetches. */
  interact?: boolean;
  /** Load the page through this proxy (a yareq proxy url). */
  proxy?: string;
}

const MAX_BODY = 5 * 1024 * 1024;
const PREVIEW = 200;
const MAX_NETWORK_ENTRIES = 15;
const MAX_SCRIPT_ENTRIES = 10;
const MAX_PAGE_TEXTS = 500;
// analytics/ad pixels return JSON too; they are never the site's data source
const TRACKER = /googleadservices|googletagmanager|google-analytics|doubleclick|facebook\.com\/tr|connect\.facebook|pinterest|hotjar|clarity\.ms|tiktok|analytics\.|\/cdn-cgi\//i;
// what every browser request carries; anything else is the page's own and may be needed to replay a call
const STANDARD_HEADERS = /^(:|accept-encoding$|accept-language$|cookie$|user-agent$|referer$|origin$|sec-|upgrade-insecure-requests$|cache-control$|pragma$|priority$|content-length$|connection$|host$)/i;
const MAX_PICKERS = 5;

export async function probePage(url: string, options: ProbeOptions = {}): Promise<ProbeReport> {
  // puppeteer is ESM-only: dynamic import keeps it out of the crawler CLI and
  // lets jest load it under --experimental-vm-modules
  const { default: puppeteer } = await import('puppeteer');
  const browser: Browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', ...browserProxyArgs(options.proxy)],
  });
  try {
    const page = await browser.newPage();
    const ua = REQUEST_HEADERS.find(([name]) => name === 'User-Agent')?.[1];
    if (ua) await page.setUserAgent(ua);

    // the calls the page made, until a picker is changed; then what that changed fetches
    let captured = new Map<string, ProbeNetworkEntry>();
    const reads: Promise<void>[] = [];
    page.on('response', (res) => {
      const contentType = res.headers()['content-type'] ?? '';
      const request = res.request();
      const requestHeaders: { [name: string]: string } = {};
      for (const [name, value] of Object.entries(request.headers())) {
        if (!STANDARD_HEADERS.test(name)) requestHeaders[name] = value;
      }
      const entry: ProbeNetworkEntry = {
        method: request.method(),
        url: res.url(),
        requestBody: request.postData(),
        requestHeaders,
        status: res.status(),
        contentType,
        bytes: 0,
        body: '',
        pageTextHits: 0,
        pageTextPaths: [],
      };
      captured.set(`${entry.method} ${entry.url} ${entry.requestBody ?? ''}`, entry);
      const length = Number(res.headers()['content-length'] ?? 0);
      const json = /json/i.test(contentType) || /\.json(\?|$)/.test(res.url());
      // a script's own call answering with markup or text: a template fragment, a variant's buying options
      const fragment = ['xhr', 'fetch'].includes(request.resourceType()) && /html|text\/plain|xml/i.test(contentType);
      if ((json || fragment) && length < MAX_BODY) {
        reads.push(
          res
            .text()
            .then((text) => {
              if (text.length > MAX_BODY) return;
              entry.bytes = text.length;
              entry.body = text;
            })
            .catch(() => {})
        );
      }
    });

    const timeout = options.timeoutMs ?? 30_000;
    const doc = await page.goto(url, { waitUntil: 'networkidle2', timeout });
    if (!doc) throw new Error(`probe got no response from ${url}`);
    // networkidle2 tolerates two open requests, and a slow data call is often one of them
    await page.waitForNetworkIdle({ idleTime: 500, concurrency: 0, timeout }).catch(() => {});
    // a streamed or long-polled response never finishes: wait no longer than the page load may
    await Promise.race([Promise.all(reads), sleep(timeout)]);
    // read the body while the inspector cache is still fresh; huge pages can
    // evict it before a later read, and the rendered DOM is a good fallback
    const raw = await doc.text().catch(() => null);
    const rendered = await page.content();
    const title = await page.title();
    const rawHtml = raw ?? rendered;
    const pageTexts = visibleLines(await page.evaluate(() => document.body?.innerText ?? ''));

    const framework: string[] = [];
    if (/__NEXT_DATA__|\/_next\//.test(rawHtml)) framework.push('next.js');
    if (/__NUXT_DATA__|window\.__NUXT__|\/_nuxt\//.test(rawHtml)) framework.push('nuxt/vue');
    if (/ng-version=/.test(rawHtml)) framework.push('angular');
    else if (/\sdata-v-[0-9a-f]{6,8}|__VUE__/.test(rendered)) framework.push('vue');
    if (/data-reactroot|_reactRootContainer|react\.production/.test(rawHtml + rendered)) framework.push('react');
    if (/Shopify\.shop|cdn\.shopify|myshopify\.com/.test(rawHtml)) framework.push('shopify');
    if (/\/wp-content\/|\/wp-includes\/|name="generator" content="WordPress/i.test(rawHtml)) framework.push('wordpress');
    if (/\/mage\/|static\/frontend\/Magento/.test(rawHtml)) framework.push('magento');
    if (/demandware\.static|SalesforceCommerceCloud/.test(rawHtml)) framework.push('demandware');

    const parsed = parse(rawHtml, { baseUrl: doc.url() });
    const jsonLdTypes = [...new Set(jsonLd(parsed).map((node) => String(node['@type'])).filter((t) => t && t !== 'undefined'))];

    const embeddedScripts: ProbeScript[] = [];
    for (const script of parsed.find('script')) {
      if (script.attr('src')) continue;
      const text = script.textContent ?? '';
      if (text.length < 40 || text.length > 2 * 1024 * 1024) continue;
      const isJson = /^\s*[{[]/.test(text);
      const assign =
        /(?:window|globalThis)\.([A-Za-z_$][\w.$]*)\s*=\s*[{[]/.exec(text) ??
        /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*[{[]/.exec(text);
      if (!isJson && !assign) continue;
      const start = isJson ? text.search(/\S/) : assign!.index + assign![0].length - 1;
      let parses = false;
      const end = closingBracket(text, start);
      if (end !== -1) {
        try {
          JSON.parse(text.slice(start, end + 1));
          parses = true;
        } catch {
          // a JavaScript object literal: embeddedJson will not read it either
        }
      }
      const type = script.attr('type');
      embeddedScripts.push({
        marker: isJson
          ? `(pure JSON script${type && type !== 'application/json' ? `, type=${type}` : ''})`
          : rawHtml.includes(`window.${assign![1]}`)
            ? `window.${assign![1]} =`
            : `${assign![1]} =`,
        parses,
        bytes: text.length,
        preview: text.slice(0, PREVIEW),
        pageTextHits: textHits(text, pageTexts),
      });
      if (embeddedScripts.length >= MAX_SCRIPT_ENTRIES) break;
    }

    let interactions: ProbeReport['interactions'];
    if (options.interact) {
      const initial = captured;
      captured = new Map();
      const pickers = await choosePickerValues(page, timeout);
      await Promise.race([Promise.all(reads), sleep(timeout)]);
      interactions = { pickers, network: rankNetwork([...captured.values()], doc.url(), pageTexts) };
      captured = initial;
    }

    const headers = doc.headers();
    return {
      document: {
        status: doc.status(),
        finalUrl: doc.url(),
        contentType: headers['content-type'] ?? '',
        rawBytes: rawHtml.length,
        renderedBytes: rendered.length,
        title,
        pageTexts: pageTexts.length,
      },
      framework,
      jsonLdTypes,
      embeddedScripts,
      network: rankNetwork([...captured.values()], doc.url(), pageTexts),
      ...(interactions ? { interactions } : {}),
      rendered,
    };
  } finally {
    await browser.close();
  }
}

/** The data calls among the responses, scored by the page texts they carry, best first. */
function rankNetwork(entries: ProbeNetworkEntry[], documentUrl: string, pageTexts: string[]): ProbeNetworkEntry[] {
  return entries
    .filter((entry) => entry.bytes > 0 && entry.url !== documentUrl && !TRACKER.test(entry.url))
    .map((entry) => ({ ...entry, pageTextHits: textHits(entry.body, pageTexts), pageTextPaths: textPaths(entry.body, pageTexts) }))
    .sort((a, b) => b.pageTextHits - a.pageTextHits || b.bytes - a.bytes)
    .slice(0, MAX_NETWORK_ENTRIES);
}

/**
 * Picks another value in each option picker - a select, or a radio group - the
 * way a shopper does, waiting for the network after each; returns what it chose.
 */
async function choosePickerValues(page: import('puppeteer').Page, timeout: number): Promise<string[]> {
  const chosen: string[] = [];
  const selects = await page.$$('select');
  for (const select of selects.slice(0, MAX_PICKERS)) {
    const next = await select.evaluate((el) => {
      const options = [...el.options].filter((o) => o.value && !o.disabled);
      const other = options.find((o) => o.value !== el.value);
      return other ? { name: el.name || el.id || 'select', value: other.value, label: other.text.trim() } : null;
    });
    if (!next) continue;
    await select.select(next.value);
    chosen.push(`${next.name} = ${next.label}`);
    await page.waitForNetworkIdle({ idleTime: 500, concurrency: 0, timeout }).catch(() => {});
  }
  const radios = await page.$$eval('input[type="radio"]:not(:checked):not([disabled])', (inputs) =>
    [...new Set(inputs.map((input) => (input as HTMLInputElement).name).filter(Boolean))]
  );
  for (const name of radios.slice(0, MAX_PICKERS)) {
    const radio = await page.$(`input[type="radio"][name="${name.replace(/"/g, '\\"')}"]:not(:checked):not([disabled])`);
    if (!radio) continue;
    // swatch inputs are often hidden behind their label: click the input through the DOM
    const label = await radio.evaluate((el) => {
      (el as HTMLInputElement).click();
      return (el as HTMLInputElement).value;
    });
    chosen.push(`${name} = ${label}`);
    await page.waitForNetworkIdle({ idleTime: 500, concurrency: 0, timeout }).catch(() => {});
  }
  return chosen;
}

/** Distinct lines a shopper reads on the page - names, prices, headings - to find the response that carries them. */
function visibleLines(text: string): string[] {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length >= 3 && line.length <= 100);
  return [...new Set(lines)].slice(0, MAX_PAGE_TEXTS);
}

function textHits(body: string, texts: string[]): number {
  return texts.filter((text) => body.includes(text) || body.includes(JSON.stringify(text).slice(1, -1))).length;
}

const MAX_TEXT_PATHS = 5;

/** Where in a JSON body the page's texts live: the string leaves equal to one, grouped by path with indexes as `*`. */
function textPaths(body: string, texts: string[]): string[] {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return [];
  }
  const wanted = new Set(texts);
  const counts = new Map<string, number>();
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      if (wanted.has(v.trim())) counts.set(path, (counts.get(path) ?? 0) + 1);
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item, path ? `${path}.*` : '*');
    } else if (v && typeof v === 'object') {
      for (const [key, item] of Object.entries(v)) walk(item, path ? `${path}.${key}` : key);
    }
  };
  walk(value, '');
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TEXT_PATHS)
    .map(([path, count]) => `${path} (${count})`);
}
