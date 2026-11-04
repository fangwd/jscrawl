// The jscrawl CLI, for a deployment's `src/cli.ts` to run after it has
// registered its domain: `npm run jscrawl -- --help`. Crawls and one-shot
// scrapes run as this CLI's children of the server (core/supervisor.ts).

import * as fs from 'fs';
import { dirname } from 'path';
import { Response } from 'yareq';
import { loadConfig } from '../core/config';
import { BLOCKED_EXIT_CODE, Config } from '../core/models';
import { domain } from '../core/domain';
import { describeFailure, describeRegistration, populateSites, registerSite } from '../core/register';
import { describeStale, removeSite, staleSites } from '../core/prune';
import { createInterface } from 'readline/promises';
import { liveCheck } from '../core/live-check';
import { scrapePreview } from '../core/preview';
import { getCrawler, getDatabase, sha1 } from '../core/utils';

import { z } from 'zod';

const Command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setup"), argv: z.array(z.string()).length(1) }),
  z.object({ type: z.literal("sync"), argv: z.array(z.string()).length(0), yes: z.boolean().optional() }),
  z.object({ type: z.literal("scrape-file"), argv: z.array(z.string()).length(3), url: z.string().optional() }),
  z.object({
    type: z.literal("add-url"),
    kind: z.string(),
    argv: z.array(z.string()),
  }),
  z.object({ type: z.literal("crawl"), argv: z.array(z.string()) }),
  z.object({ type: z.literal("fetch"), argv: z.array(z.string()) }),
  z.object({
    type: z.literal("scrape"),
    argv: z.array(z.string()),
    flush: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("scrape-url"),
    argv: z.array(z.string()),
    flush: z.boolean().optional(),
  }),
  z.object({ type: z.literal("html"), argv: z.array(z.string()) }),
  z.object({
    type: z.literal("add-urls"),
    kind: z.string(),
    regex: z.string(),
    site: z.string(),
    priority: z.number(),
    argv: z.array(z.string()),
  }),
  z.object({ type: z.literal("reset"), argv: z.array(z.string()) }),
  z.object({ type: z.literal("export-feed"), argv: z.array(z.string()).length(2) }),
  z.object({ type: z.literal("live-check"), argv: z.array(z.string()).length(2) }),
]);
type Command = z.infer<typeof Command>;

const USAGE = `npm run jscrawl -- <command>
  --setup <site>                              register crawlers/<site>.ts and queue its SEED_URL
  --sync [--yes]                              register every crawler and remove the sites, data and test
                                              pages of crawlers that are gone (npm run jscrawl:sync);
                                              asks before removing unless --yes
  --scrape-file <site> <type> <file> [--url <url>]
                                              print the records a saved page yields; writes nothing
  --add-url <url>... --kind <type>            queue urls with a type (seed, category, product)
  --add-urls <file.json> --site <site> --kind <type> --regex <re> --priority <n>
                                              queue the matching urls of a json list
  --fetch <url>...                            fetch and save queued urls without scraping
  --scrape-url <url>...                       fetch, scrape and save queued urls
  --scrape <saved response>... [--flush]      re-scrape saved responses; --flush writes
  --crawl <site>                              crawl a site until its queue is empty
  --html <saved response> <out.html>          write a saved response's body to a file
  --reset <site>                              idle the site's urls
  --export-feed <site> <file.zip>             write the site's feed (the domain's; /api/docs/feed-format)
  --live-check <url id> <out.json>            fetch the url now, scrape it without saving, write its diff with the saved records`;

let config!: Config;

function parseCommand(): Command {
  const options: {
    argv: string[];
    [key: string]: string | string[] | boolean | number;
  } = { argv: [] };

  for (let i = 2; i < process.argv.length; i++) {
    const argv = process.argv[i];
    const match = /^--([^\s]+)$/.exec(argv);
    if (!match) {
      options.argv.push(argv);
    }
    else if (/^(setup|sync|scrape-file|add-url|fetch|scrape-url|scrape|crawl|html|add-urls|reset|export-feed|live-check)$/.test(match[1])) {
      options['type'] = match[1];
    }
    else if (/^(kind|type|regex|site|url)$/.test(match[1])) {
      i++;
      options[match[1]] = process.argv[i];
    }
    else if (/^(priority)$/.test(match[1])) {
      i++;
      options[match[1]] = +process.argv[i];
    } else if (/^(flush|yes)$/.test(match[1])) {
      options[match[1]] = true;
    }
    else if (match[1] === 'help') {
      console.log(USAGE);
      process.exit(0);
    }
    else {
      throw new Error(`Unknown option: ${argv}\n\n${USAGE}`);
    }
  }

  if (!config) {
    config = loadConfig();
  }

  return Command.parse(options);
}

const print = console.log;

/** The jscrawl CLI over `process.argv`; the deployment's domain must be registered first. */
export async function runCli(): Promise<void> {
  const cmd = parseCommand();
  switch (cmd.type) {
    case "setup":
      await setup(cmd.argv[0]);
      break;
    case "sync":
      await sync(cmd.yes ?? false);
      break;
    case "scrape-file":
      await scrapeFile(cmd.argv[0], cmd.argv[1], cmd.argv[2], cmd.url);
      break;
    case "add-url":
      {
        const crawler = await getCrawler(config, cmd.argv[0]);
        for (const argv of cmd.argv) {
          crawler.db.addUrl(argv, cmd.kind, null);
          // --kind is explicit intent: it wins over the type a crawler queued.
          crawler.db.retypeUrl(argv, cmd.kind);
        }
        await crawler.db.flush();
        await crawler.db.end();
      }
      break;
    case "add-urls":
      await addUrls(cmd.site, cmd.argv[0], cmd.regex, cmd.priority, cmd.kind);
      break;
    case "crawl":
      if (cmd.argv.length === 0) {
        throw new Error(`Missing site name`);
      }
      await crawl(cmd.argv[0]);
      break;
    case "fetch":
    case "scrape-url":
      for (const argv of cmd.argv) {
        const crawler = await getCrawler(config, argv);
        try {
          await crawler.bootstrap();
          const url = await crawler.db.getUrl(argv);
          await crawler.process(url, { scrape: cmd.type === "scrape-url" });
        } finally {
          await crawler.db.end();
          await crawler.close();
        }
      }
      break;
    case "scrape":
      {
        for (const entry of cmd.argv) {
          const response = await Response.load(entry);
          const crawler = await getCrawler(config, response.requestUrl);
          const url = await crawler.db.getUrl(response.requestUrl);
          await crawler.scrape(response, url);
          if (cmd.flush) {
            await crawler.db.flush();
          }
          crawler.db.clear();
          await crawler.db.end();
        }
      }
      break;
    case "html":
      {
        const response = await Response.load(cmd.argv[0]);
        fs.writeFileSync(cmd.argv[1], response.body);
      }
      break;
    case "reset":
      {
        if (cmd.argv.length === 0) {
          throw new Error(`Missing site name`);
        }
        await reset(cmd.argv[0]);
      }
      break;
    case "export-feed":
      await writeFeed(cmd.argv[0], cmd.argv[1]);
      break;
    case "live-check":
      fs.writeFileSync(cmd.argv[1], JSON.stringify(await liveCheck(config, Number(cmd.argv[0]))));
      break;
    default:
      throw new Error(`Unknown command ${JSON.stringify(cmd)}`);
  }
}

// npm run jscrawl -- --setup <site>
// Registers (or updates) one crawler, its site and its optional SEED_URL.
async function setup(name: string) {
  const db = await getDatabase(config);
  const registration = await registerSite(db, config, name);
  await db.flush();
  await db.end();
  print(describeRegistration(registration));
}

// npm run jscrawl:sync
// Registers (or updates) every crawler module in the sites directory, then
// removes the sites, crawled data and test pages of crawlers no longer there.
async function sync(yes: boolean) {
  const db = await getDatabase(config);
  try {
    const { registrations, failures } = await populateSites(db, config);
    for (const registration of registrations) print(describeRegistration(registration));
    for (const failure of failures) print(describeFailure(failure));
    print(`Registered ${registrations.length} site(s)${failures.length ? `; ${failures.length} failed` : ''}`);
    if (failures.length) process.exitCode = 1;

    const stale = await staleSites(db, config);
    if (stale.length === 0) return;
    print(`\nNo crawler module for ${stale.length} name(s); removing them takes away:`);
    for (const site of stale) print(`  ${describeStale(site)}`);
    const removable = stale.filter((site) => !site.running);
    if (removable.length === 0) return;
    if (!yes && !(await confirmed(`Remove ${removable.length} of them for good? [y/N] `))) {
      print('Nothing removed.');
      return;
    }
    for (const site of removable) {
      await removeSite(db, config, site);
      print(`Removed ${site.name}`);
    }
  } finally {
    await db.end();
  }
}

/** A yes from the terminal; without one (piped, CI) the answer is no: pass --yes. */
async function confirmed(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    print('Not removing without a terminal to confirm on: pass --yes.');
    return false;
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await terminal.question(question)).trim());
  } finally {
    terminal.close();
  }
}

// npm run jscrawl -- --scrape-file <site> <seed|category|product> <page.html> [--url <page url>]
// Runs a crawler on a saved page and prints the records it would save; nothing is written.
async function scrapeFile(name: string, type: string, file: string, pageUrl = 'https://example.invalid/page') {
  const preview = await scrapePreview(config, name, type, file, pageUrl);
  const plain: { [table: string]: object[] } = {};
  for (const [table, { records }] of Object.entries(preview)) plain[table] = records;
  print(JSON.stringify(plain, null, 2));
}

// npm run jscrawl -- --add-urls beaumont-urls.json --site beaumont-tiles --kind product --regex '.com.au/\d+' --priority 100
async function addUrls(
  siteName: string,
  fileName: string,
  filter: string,
  priority: number,
  type: string,
) {
  const db = await getDatabase(config);
  const site = await db.table("site").get({ name: siteName });
  const rows: Array<{ url: string }> = JSON.parse(
    fs.readFileSync(fileName).toString()
  );
  const re = new RegExp(filter);
  for (const { url } of rows) {
    if (re.test(url)) {
      db.table("url").append({
        url,
        type,
        site: site.id,
        hash: sha1(url), // XXX: Add a global hashUrl function
        priority,
      });
    }
  }
  await db.flush();
  await db.end();
}

// npm run jscrawl -- --export-feed <site> <file.zip>
// Writes the site's feed as the domain defines it.
async function writeFeed(site: string, file: string) {
  const feed = domain().feed;
  if (!feed) throw new Error('This domain has no feed');
  const db = await getDatabase(config);
  try {
    const [row] = await db.query<{ id: number }[]>('select id from site where name = ?', site);
    if (!row) throw new Error(`No site named "${site}"`);
    const { bytes, summary } = await feed.export(Number(row.id), db as any);
    fs.mkdirSync(dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    print(`${summary}\nwritten to ${file}`);
  } finally {
    await db.end();
  }
}

async function crawl(site: string) {
  const crawler = await getCrawler(config, site);
  try {
    await crawler.bootstrap();
    // first signal stops gracefully after the current url; a second one kills
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        crawler.stop.requested = true;
      });
    }
    await crawler.run();
    await crawler.db.flush();
    // a crawl that ran out of urls is complete; one stopped part way says nothing about the catalogue
    if (!crawler.stop.requested) {
      await crawler.checkRegression();
      await crawler.checkExpectations();
    }
  } finally {
    await crawler.db.end();
    await crawler.close();
  }
  if (crawler.refusals.blocked) process.exitCode = BLOCKED_EXIT_CODE;
}

async function reset(site: string) {
  const crawler = await getCrawler(config, site);
  await crawler.db.resetUrls({});
  await crawler.db.end();
}
