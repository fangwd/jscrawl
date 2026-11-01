#!/usr/bin/env bash
# Starts everything jscrawl needs: Postgres via docker-compose (or the database
# named by DATABASE_URL in the environment or .env), the schema on a brand-new
# database only (never reloads over existing data), then the jscrawl server on
# :3120 (the API, and the agent's tools at /mcp). spidermake - the agent and the
# dashboard - runs on its own.
set -euo pipefail
cd "$(dirname "$0")/.."

# The app reads .env; use the same DATABASE_URL here so the schema and server
# cannot point at different databases. An exported value still wins.
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  DATABASE_URL=$(node -e 'process.loadEnvFile(".env"); process.stdout.write(process.env.DATABASE_URL ?? "")')
  export DATABASE_URL
fi

if [ -n "${DATABASE_URL:-}" ]; then
  echo "== database (DATABASE_URL) =="
  tables=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc \
    "select count(*) from information_schema.tables where table_schema = 'public'")
  if [ "$tables" = 0 ]; then
    echo "empty database: loading etc/schema.sql"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 < etc/schema.sql
  else
    echo "schema present ($tables public tables); leaving data untouched"
  fi
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 < etc/migrate-page-snapshots.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction < etc/migrate-crawl-settings.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 < etc/migrate-variant-order.sql
else
  echo "== postgres =="
  docker-compose up -d
  for i in $(seq 1 30); do
    if docker exec jscrawl-postgres pg_isready -U admin -q; then break; fi
    if [ "$i" = 30 ]; then echo "postgres did not become ready in 30s" >&2; exit 1; fi
    sleep 1
  done

  echo "== database =="
  docker exec -i jscrawl-postgres psql -U admin -d postgres -tAc "select 1 from pg_database where datname = 'jscrawl'" | grep -q 1 \
    || docker exec -i jscrawl-postgres psql -U admin -d postgres -c "CREATE DATABASE jscrawl OWNER admin"
  tables=$(docker exec -i jscrawl-postgres psql -U admin -d jscrawl -tAc \
    "select count(*) from information_schema.tables where table_schema = 'public'")
  if [ "$tables" = 0 ]; then
    echo "empty database: loading etc/schema.sql"
    docker exec -i jscrawl-postgres psql -U admin -d jscrawl -v ON_ERROR_STOP=1 < etc/schema.sql
  else
    echo "schema present ($tables public tables); leaving data untouched"
  fi
  docker exec -i jscrawl-postgres psql -U admin -d jscrawl -v ON_ERROR_STOP=1 < etc/migrate-page-snapshots.sql
  docker exec -i jscrawl-postgres psql -U admin -d jscrawl -v ON_ERROR_STOP=1 --single-transaction < etc/migrate-crawl-settings.sql
  docker exec -i jscrawl-postgres psql -U admin -d jscrawl -v ON_ERROR_STOP=1 < etc/migrate-variant-order.sql
fi

echo "== crawlers =="
if [ -d crawlers/.git ]; then
  echo "$(ls crawlers/*.ts 2>/dev/null | wc -l | tr -d ' ') crawler(s)"
elif [ -d crawlers ]; then
  echo "crawlers/ is present but is not a git repository" >&2
else
  echo "no crawlers/: clone the crawlers repository there, or jscrawl:populate will fail" >&2
fi

echo "== server =="
echo "jscrawl on http://127.0.0.1:${JSCRAWL_PORT:-3120}"
exec node -r ts-node/register src/server.ts
