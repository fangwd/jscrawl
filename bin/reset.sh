#!/usr/bin/env bash
# Resets jscrawl's stores. Nothing here is recoverable: the domain database (the
# one DATABASE_URL names, else the docker one) is reloaded from etc/schema.sql,
# and the files listed below are deleted. Emptying the domain database asks twice.
# The agent's conversations are spidermake's.
#
#   bin/reset.sh                 # everything (asks first)
#   bin/reset.sh --db            # Postgres domain data only
#   bin/reset.sh --snapshots     # saved pages and images (data/html, data/images)
#   bin/reset.sh --logs          # crawl logs (data/logs)
#   bin/reset.sh --test          # reload the schema into jscrawl_test
#   bin/reset.sh --e2e           # reload the schema into the e2e database
#   bin/reset.sh --all           # db + snapshots + logs
#   bin/reset.sh --all --keep-snapshots
#   bin/reset.sh --yes           # no prompts (CI)
#
# Never touched: crawlers/ (its own repository, with the crawlers' test pages),
# .env, build/.
set -euo pipefail
cd "$(dirname "$0")/.."

# The app and start.sh read .env; resolve the same database here. An
# exported value still wins.
if [ -f .env ]; then
  eval "$(node -e '
    process.loadEnvFile(".env");
    for (const key of ["DATABASE_URL"]) {
      const value = process.env[key];
      if (value === undefined) continue;
      const quoted = JSON.stringify(value).replace(/[$`]/g, "\\$&");
      process.stdout.write("export " + key + "=" + quoted + "\n");
    }
  ')"
fi

container=${POSTGRES_CONTAINER:-jscrawl-postgres}
schema=etc/schema.sql
db_all=0 db=0 snapshots=0 logs=0 test_db=0 e2e=0 keep_snapshots=0 assume_yes=0

while [ $# -gt 0 ]; do
  case "$1" in
    --db) db=1 ;;
    --snapshots) snapshots=1 ;;
    --logs) logs=1 ;;
    --test) test_db=1 ;;
    --e2e) e2e=1 ;;
    --all) db_all=1 ;;
    --keep-snapshots) keep_snapshots=1 ;;
    --yes|-y) assume_yes=1 ;;
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) echo "reset: unknown option $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

if [ "$db_all" = 1 ]; then
  db=1 logs=1
  [ "$keep_snapshots" = 1 ] || snapshots=1
fi
if [ "$db" = 0 ] && [ "$snapshots" = 0 ] && [ "$logs" = 0 ] \
   && [ "$test_db" = 0 ] && [ "$e2e" = 0 ]; then
  db_all=1 db=1 logs=1 snapshots=1
fi

# The database the app itself uses, so this cannot drift from etc/config.json.
config_db() {
  JSCRAWL_CONFIG=${JSCRAWL_CONFIG:-etc/config.json} node -e '
    const { readFileSync } = require("fs");
    const config = JSON.parse(readFileSync(process.env.JSCRAWL_CONFIG, "utf8"));
    process.stdout.write(config.database.connection.database);
  '
}
e2e_db() {
  node -e '
    const { readFileSync } = require("fs");
    const config = JSON.parse(readFileSync("etc/config.e2e.json", "utf8"));
    process.stdout.write(config.database.connection.database);
  '
}

docker_psql() { docker exec -i "$container" psql -U admin -d "$1" -v ON_ERROR_STOP=1 "${@:2}"; }
domain_psql() {
  if [ -n "${DATABASE_URL:-}" ]; then psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
  else docker_psql "$(config_db)" "$@"; fi
}
domain_name() {
  if [ -n "${DATABASE_URL:-}" ]; then printf '%s' "${DATABASE_URL##*@}"
  else config_db; fi
}

reload_schema() {
  echo "-- reloading $schema into $1"
  "${@:2}" < "$schema"
}

size_of() { du -sh "$1" 2>/dev/null | cut -f1 || echo "-"; }

echo "reset will:"
[ "$db" = 1 ] && echo "  - drop and reload the '$(domain_name)' database ($(domain_psql -tAc 'select count(*) from url' 2>/dev/null || echo '?') urls)"
[ "$snapshots" = 1 ] && echo "  - delete saved pages and images: data/html ($(size_of data/html)), data/images ($(size_of data/images))"
[ "$logs" = 1 ] && echo "  - delete crawl logs: data/logs ($(size_of data/logs))"
[ "$test_db" = 1 ] && echo "  - drop and reload the 'jscrawl_test' database"
[ "$e2e" = 1 ] && echo "  - drop and reload the '$(e2e_db)' database"
echo "and keeps crawlers/, .env and build/."

if [ "$assume_yes" != 1 ]; then
  printf "continue? [y/N] "
  read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) echo "reset: cancelled"; exit 1 ;; esac
  if [ "$db" = 1 ]; then
    echo "This permanently empties the crawler database '$(domain_name)'."
    printf "type 'empty' to confirm: "
    read -r answer
    [ "$answer" = empty ] || { echo "reset: cancelled"; exit 1; }
  fi
fi

if [ "$db" = 1 ]; then reload_schema "$(domain_name)" domain_psql; fi
if [ "$test_db" = 1 ]; then reload_schema jscrawl_test docker_psql jscrawl_test; fi
if [ "$e2e" = 1 ]; then reload_schema "$(e2e_db)" docker_psql "$(e2e_db)"; fi
if [ "$snapshots" = 1 ]; then
  rm -rf data/html data/images
  echo "-- deleted data/html and data/images"
fi
if [ "$logs" = 1 ]; then
  rm -rf data/logs
  echo "-- deleted data/logs"
fi

if [ "$db" = 1 ]; then
  echo
  echo "The domain database is empty. Re-register every crawler:"
  echo "  npm run jscrawl:populate"
fi
echo "reset: done"
