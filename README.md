# jscrawl

Crawl engine with an HTTP API and MCP tools. It handles URL discovery, fetching,
robots.txt, pacing, saved responses, crawl runs and issues. A domain app defines
what each page produces through a single
[`DomainConfig`](src/core/domain.ts).

## Install

```sh
npm install jscrawl-core
```

```ts
import { Crawler } from 'jscrawl-core/base-crawler';
import { CoreDatabase } from 'jscrawl-core/base-database';
import { useDomain } from 'jscrawl-core/domain';
```

Other exports include `jscrawl-core/extract`, `jscrawl-core/mcp/tools`,
`jscrawl-core/web/routes` and `jscrawl-core/entries/*`.

## Development

Use Node.js 26 (pinned in `.nvmrc`) and PostgreSQL 17. Database-backed tests use `127.0.0.1:5434`,
database `jscrawl_test`, user `admin`, password `secret`:

```sh
docker run --detach --name jscrawl-test-postgres \
  --publish 127.0.0.1:5434:5432 \
  --env POSTGRES_USER=admin \
  --env POSTGRES_PASSWORD=secret \
  --env POSTGRES_DB=jscrawl_test \
  postgres:17
```

Then run:

```sh
npm install
npm run typecheck
npm run build
npm run test:schema
npm test
```

`test:schema` **replaces the test database's tables and data**. Leave
`DATABASE_URL` unset so schema loading and tests target the same database.
