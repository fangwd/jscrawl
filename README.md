# jscrawl

The crawl core: a site crawler's engine, the surface an operator and an agent
work it through, and the contract a domain app configures it with. It knows
urls, fetching, robots.txt and pacing, saved pages, crawl runs and issues; it
does not know what a page produces. A domain app does - products, articles,
listings - and hands the core one `DomainConfig` (`src/core/domain.ts`).
[aether-feed](https://github.com/fangwd/aether-feed) is the first: the
e-commerce crawl, and the deployment that runs it.

`separate-core-app-impl.md` is the specification this shape follows, with
the migration's progress.

```
src/core/           the engine: base crawler and database, fetch, robots, sitemaps, the url frontier,
                    issues, snapshots and regressions, previews and the fixture harness, the crawlers
                    git flow, the domain contract and registry, migrations, the conformance kit (testing/)
src/mcp/tools.ts    the agent's tools; a domain adds its own
src/web/            the HTTP API, with the domain's records API (sqlex/api) mounted beside it
src/entries/        the programs a deployment runs: server, tool server, CLI, migrations
skills/             the agent's core skills; a domain's are merged over them
etc/                the core's schema and migrations; a domain ships its own
```

## Using it

The package is `@jscrawl/core`, installed from git and built on install:

```json
"dependencies": { "@jscrawl/core": "github:fangwd/jscrawl#<tag>" }
```

Modules are imported by path: `@jscrawl/core/base-crawler`,
`@jscrawl/core/domain`, `@jscrawl/core/extract`, `@jscrawl/core/mcp/tools`,
`@jscrawl/core/web/routes`. A deployment registers its domain and runs the
core's programs; [Adding a domain](#adding-a-domain) walks through it, and
aether-feed's `src/` shows the shape.

What a domain declares, in one object: its page types; its tables (schema
files and migrations) and the database class with its typed writes; its
crawler base; what a valid page is, what a site's metrics are and what counts
as a regression; what `site.expect` means; its fixture contract; its inspect
tool and other tools; its skills; its feed; its records API and the hints
the dashboard renders it with; the natural keys of the live check; and the
services it relies on. The database class must pass the conformance kit
(`src/core/testing/conformance.ts`), which states the write protocol a crawl
relies on.

What the core serves about the domain, beside the crawl's own routes:

- `GET /api/domain`: its name, page types, inspect tool, whether it has a feed
  and a live check, and its UI hints. The dashboard
  ([jscrawl-ui](https://github.com/fangwd/jscrawl-ui)) renders the domain's
  records from this and the records API, with no page of its own per domain.
- `/api/d/`: the records API, and its OpenAPI document at
  `/api/d/openapi.json`. Every relation a hint walks is embeddable.
- `GET /api/skills`: the agent's skills, the core's merged with the domain's,
  with the domain's inspect tool filled in, and its part of the instructions.
  spidermake loads them at start.
- `POST /api/urls/:id/live-check`: the url fetched and scraped now without
  saving, diffed table by table with what was saved from it, by the keys the
  domain declares. It runs the deployment's CLI (`src/cli.ts --live-check`),
  since it runs crawler code.

### Proxies

A site whose content depends on where the visitor is (prices by country)
fetches through a proxy, of a type the deployment's proxy provider offers and
pinned to a country, from its crawler's `site`:

```ts
export const site: SiteConfig = { waitTime: 3, proxy: { type: 'residential', country: 'AU' } };
```

The provider is any service implementing
[docs/proxy-provider.md](docs/proxy-provider.md), named by `PROXY_PROVIDER_URL`
and `PROXY_PROVIDER_TOKEN`; without them a site that asks for a proxy fails
instead of fetching directly. Everything a crawl fetches goes through the
site's proxy - pages, robots.txt, a handler's `fetch`, the browser under
`usePuppeteer` - as do the agent's webfetch, pageProbe, coverage and previews
for that site (`site` names a crawler not registered yet). A failed request
is retried on a renewed route, or a new proxy when the old one stopped
answering, before it counts towards the crawl's blocked rule.

The dashboard's Proxies page (`GET /api/proxies`) lists the provider's proxies
and who holds each - a crawl run, the agent's tools, a CLI process - flagging
those whose holder is gone, and the sites that fetch through one. A proxy can
be renewed, removed, or checked: `POST /api/proxies/:id/check` fetches
`PROXY_CHECK_URL` (default `https://ipinfo.io/json`; any URL answering
`{"ip": ..., "country": ...}`) through it to show where its requests come out.

## Adding a domain

A domain is an app repository that is also its deployment: the domain's code,
the four entry files and its config, with the crawlers repository checked out
inside it. The core's test
domain (`test/support/domain.ts`) is the smallest complete one; aether-feed's
`src/ecommerce/index.ts` is a full one.

1. **The repository.** Start from aether-feed's `package.json`, `tsconfig.json`
   and jest config. Depend on `@jscrawl/core`, which brings its own runtime
   libraries, plus what the domain's code imports itself, usually
   `gumbo-html`, `sqlex` and `zod`. `etc/config.json` names the database;
   `DATABASE_URL` overrides it.
2. **The tables.** `schema.files` are loaded after the core's into an empty
   database. Reference the core by `site.id` and `url.id` only. A record a
   page produces carries `site_id`. A table the live check compares as the
   page's own links to `url`, by a foreign key or through a join table.
   Later changes go in `schema.migrations`, additive and safe to re-run,
   with `schema.version` bumped.
3. **The database class.** Extend `CoreDatabase`
   (`@jscrawl/core/base-database`) with the typed writes crawlers call,
   appending through `this.table(name)`. Nothing is written until the core
   flushes a page. Run `databaseConformance` from
   `@jscrawl/core/testing/conformance` in a test file, as aether-feed's
   `test/conformance.test.ts` does: it states the write protocol a crawl
   relies on.
4. **The crawler base.** Extend `Crawler` (`@jscrawl/core/base-crawler`). A
   url of type `listing` is handed to `scrapeListing(doc)`, so each type in
   `urlTypes` needs a `scrape<Type>` that site crawlers override; the seed
   goes to `scrapeSeed`. Override `validate(url)` to return what is wrong
   with what a page saved. The core skips it for a url whose `data` a
   crawler set, which vouches for an unusual page.
5. **The config.** One `DomainConfig` (`src/core/domain.ts`, documented field
   by field). Required: `name`, `urlTypes`, `schema`, `database`, `crawler`,
   `expectations`, `api`, `metrics`, `metricRules`, and `inspectTool`, named
   among `tools`. The rest are optional: `fixtures`, `suspects`, `pageGone`,
   `skills`, `ui`, `liveCheck`, `services` and `feed`. Without `ui` every
   model still renders from its schema.
6. **The entries.** `src/domain.ts` calls `useDomain(config)`. Four files
   import it and run the core's program, and the server and supervisor
   start them by path:

   ```
   src/server.ts       runServer      from @jscrawl/core/entries/server
   src/mcp/server.ts   runToolServer  from @jscrawl/core/entries/tool-server
   src/cli.ts          runCli         from @jscrawl/core/entries/cli
   src/migrate.ts      runMigrate     from @jscrawl/core/entries/migrate
   ```

   Tests register the domain the same way, from a jest `setupFiles` module
   that imports `src/domain.ts`.
7. **What crawlers import.** Site crawlers import by relative path from the
   deployment, never from the package: re-export at `src/core/` the
   modules they need, with the crawler base as the default export of
   `src/core/crawler.ts`. aether-feed's `src/core/` is the pattern.
8. **The skills.** `skills.dir` holds the domain's part of each core skill
   (`new-site`, `verify-url`, `audit-crawl`): a `SKILL.md` is appended to the
   core's without its front matter, other files are added beside it, and
   `{{inspectTool}}` is filled in. Include a crawler template the agent
   starts from. `skills.instructions` is appended to the agent's
   instructions.
9. **Run it.** On an empty database:

   ```
   npm run db:schema            # the core's tables, then the domain's
   npm run serve                # the API on JSCRAWL_PORT (default 3120)
   ```

   Point spidermake's `JSCRAWL_DIR` at the deployment, and the dashboard
   renders the domain from `/api/domain` and the records API.

## Moving crawlers from the single jscrawl

Before the split, jscrawl was one repository: the core, the shop domain and
the server, with the crawlers checkout inside it. Those crawlers now run in
a deployment of the domain they produce for, which for the shop crawlers is
aether-feed. A crawler file moves unchanged unless it imports something the
deployment no longer provides.

1. **Set up the deployment.** Clone aether-feed and install it as its README
   says, pointing its database settings at the old database. Back the
   database up first.
2. **Move the checkout and the saved pages.** Move `crawlers/` and `data/`
   from the old jscrawl checkout into the deployment's root. The crawlers
   repository keeps its history and remote. Carry `.env` over, checking its
   keys against aether-feed's README.
3. **Check the imports.** aether-feed re-exports, at `src/core/`, every
   module the shop crawlers imported: `crawler`, `database`, `extract`,
   `extract/embedded`, `models`, `sitemap` and `platforms/shopify`. Any other
   old path is gone, for example `../src/core/utils`, `fetch`, `logger` or
   an `extract/*` file. Import an extraction helper from `../src/core/extract`
   instead. For anything else, add a re-export of `@jscrawl/core/<module>`
   to the deployment's `src/core/`, and keep the crawler's import as it is.
4. **Check the page types.** `addUrl` now throws on a type the domain does
   not declare. The shop declares `category` and `product`, beside the
   core's `seed` and `image`. The hooks are unchanged: `scrapeSeed`,
   `scrapeCategory`, `scrapeProduct`, and the `validate` overrides.
5. **Upgrade the database.** `npm run db:migrate` runs the core's
   migrations, then the domain's, and records both versions in
   `schema_version`. It is additive and safe to re-run. It refuses a
   database whose core schema is newer than the installed core.
6. **Bring the fixtures up to the domain's contract.** The shop requires a
   `sections` inventory on every product page in a crawler's
   `crawlers/fixtures/<name>/pages.json` (aether-feed's
   `skills/new-site/completeness.md`). An entry without one fails the
   check. Crawlers are agent-maintained, so have the agent add it.
7. **Check and switch.** Run the crawlers on their fixtures, then register
   them, which updates the site rows already there:

   ```
   npm run crawlers:check [site...]
   npm run jscrawl:sync
   ```

   Point spidermake's `JSCRAWL_DIR` at the deployment and restart it. Then
   delete the crawlers copy left in the old checkout.

## Developing

```
npm install
npm run typecheck
npm run build                # dist/, what a dependant installs
npm run test:schema          # the core's schema and the test domain's into jscrawl_test
npm test
```

The tests run against Postgres on `127.0.0.1:5434` (database `jscrawl_test`,
user `admin`, password `secret`), or the database `DATABASE_URL` names for
`test:schema`. They register a small test domain (`test/support/domain.ts`:
pages with a title) before every file; it is also what proves the contract
works for a domain that is not a shop.

A core change is a breaking change when it breaks a site crawler in the
crawlers repository, whatever semver says: run aether-feed's
`npm run crawlers:check` against the candidate before tagging. Core
migrations are additive and never drop or rename a column of `site` or `url`
(`test/migrations.test.ts`).
