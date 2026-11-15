# Developing jscrawl

[Documentation index](README.md) · [Project README](../README.md)

This page is for working on the engine repository. To build a consuming app,
use [Getting started](getting-started.md).

## Local setup

Use Node.js 26.13.1 as pinned in [`.nvmrc`](../.nvmrc), npm 11.20 or later and
PostgreSQL 17. From the repository root:

```sh
npm install
npm run typecheck
npm run build
```

`npm install` also runs the package's `prepare` build. Published code and types
are emitted to `dist/`. `npm run watch` watches the development TypeScript
configuration and emits to `build/`.

## Database-backed tests

Tests use a local PostgreSQL instance at `127.0.0.1:5434`, database `jscrawl_test`,
user `admin`, password `secret`. Start one with:

```sh
docker run --detach --name jscrawl-test-postgres \
  --publish 127.0.0.1:5434:5432 \
  --env POSTGRES_USER=admin \
  --env POSTGRES_PASSWORD=secret \
  --env POSTGRES_DB=jscrawl_test \
  postgres:17
```

Wait for PostgreSQL to accept connections, then:

```sh
unset DATABASE_URL
npm run test:schema
npm test
```

**`test:schema` replaces the target database's tables and data.** Leave
`DATABASE_URL` unset so schema loading targets the fixed database used by most
tests. The schema script honors a shell `DATABASE_URL`, which can otherwise
point this destructive operation at a different database.

Jest registers the minimal [test domain](../test/support/domain.ts) before each
test file. The schema loader applies the core schema followed by the
[test-domain schema](../test/support/schema.sql). The runner uses one worker to
coordinate tests sharing database state.

Run one test file through the same configured runner:

```sh
npm test -- --runTestsByPath test/crawler.test.ts
```

## Checks and formatting

```sh
npm run typecheck
npm run build
npm run check:format
npm test
```

Use `npm run format` to apply repository formatting. Run the relevant tests for
behavior changes. Database tests need the disposable database initialized as
above; compilation and formatting do not.

## Repository map

| Path                                         | Role                                                         |
| -------------------------------------------- | ------------------------------------------------------------ |
| `src/core/domain.ts`                         | Domain registration and extension contract                   |
| `src/core/base-crawler.ts`                   | Fetch, extraction and validation lifecycle                   |
| `src/core/base-database.ts`                  | URL queue and buffered database writes                       |
| `src/core/extract/`                          | Shared extraction helpers                                    |
| `src/core/supervisor.ts`, `src/core/runs.ts` | Child processes, run state, heartbeats and scheduling        |
| `src/entries/`                               | Functions used by consuming app CLI/server/migration entries |
| `src/web/`                                   | HTTP routing and API implementation                          |
| `src/mcp/tools.ts`                           | Core tools and domain tool composition                       |
| `etc/`                                       | PostgreSQL schema and re-runnable core migrations            |
| `skills/`                                    | Agent workflows distributed with the package                 |
| `test/`                                      | Unit, integration and contract tests                         |
| `docs/`                                      | User and contributor guides                                  |

The engine repository does not include a production domain or a crawler
checkout. Keep examples and documentation explicit about app-provided files and
scripts. Package imports use subpaths such as `jscrawl/domain`,
`jscrawl/extract`, `jscrawl/web/routes` and `jscrawl/entries/cli`.

When changing a public contract, update its guide and examples. Core schema
changes also need a migration, a schema-version update and appropriate tests;
see [Migrations](operations.md#database-migrations).
