# jscrawl

A TypeScript crawl engine for turning websites into structured records, with a
PostgreSQL URL queue, an HTTP API and MCP tools.

jscrawl handles fetching, robots.txt, request pacing, retries, saved responses,
crawl runs and issues. Your app defines the records to collect and how to extract
them through a [`DomainConfig`](src/core/domain.ts) and site crawler classes.

## Get started

Use Node.js 26.13.1 or a compatible Node 26 release, npm 11.20 or later, and
PostgreSQL 17 (the version used for development).

```sh
npm install jscrawl
```

Import the parts you need through package subpaths:

```ts
import { Crawler } from 'jscrawl/base-crawler';
import { CoreDatabase } from 'jscrawl/base-database';
import { useDomain } from 'jscrawl/domain';
```

**[Build your first crawler →](docs/getting-started.md)** walks through a complete
app: database schema, domain registration, a site crawler, a preview and a crawl.
The npm package provides library entry functions; your app supplies the CLI and
server entry files. There is no standalone `jscrawl` executable.

## What you can build

- Extract your own record types from HTML, structured data and JSON APIs.
- Run plain HTTP crawls or use Puppeteer for pages that need JavaScript.
- Replay saved responses to improve extraction without fetching every page again.
- Monitor URL failures, validation issues, expectations and changes between crawls.
- Control crawls through HTTP or connect an MCP client to inspect and maintain them.

## Documentation

Start with the [documentation index](docs/README.md), or jump to a guide:

| Guide                                                | What it covers                                             |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| [Getting started](docs/getting-started.md)           | A complete first crawl, from an empty app                  |
| [Domains and records](docs/domains.md)               | `DomainConfig`, database writes, validation and extensions |
| [Writing site crawlers](docs/crawlers.md)            | Discovery, page handlers, extraction and fixture checks    |
| [Configuration](docs/configuration.md)               | Database, storage, site settings and environment variables |
| [CLI](docs/cli.md)                                   | Setup, crawling, previews, replay and exports              |
| [HTTP API](docs/http-api.md)                         | Authentication, endpoints and crawl control examples       |
| [MCP tools](docs/mcp.md)                             | Connection details, tools and agent workflows              |
| [Operations and troubleshooting](docs/operations.md) | Scheduling, saved pages, migrations and recovery           |
| [Development](docs/development.md)                   | Working on jscrawl and running checks                      |

## Develop jscrawl

```sh
npm install
npm run typecheck
npm run build
```

Database-backed tests also need a local PostgreSQL instance and the test schema.
Follow the [development guide](docs/development.md) before running them;
`npm run test:schema` replaces the target database's tables and data.

## License

[MIT](LICENSE).
