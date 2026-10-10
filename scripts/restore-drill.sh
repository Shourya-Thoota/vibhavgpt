#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
DUMP_FILE="${DUMP_FILE:-}"
if [ -z "$DUMP_FILE" ]; then
  DUMP_FILE="$(find "$BACKUP_DIR/daily" -type f -name '*.dump' -print 2>/dev/null | sort -r | head -n 1)"
fi
[ -n "$DUMP_FILE" ] && [ -f "$DUMP_FILE" ] || { echo "No dump file found" >&2; exit 1; }

STAMP="$(date -u +%Y%m%d%H%M%S)"
TEMP_DB="vibhavgpt_restore_$STAMP"
# Railway's DATABASE_URL points at the default database; replace only its final path.
TEMP_URL="${DATABASE_URL%/*}/$TEMP_DB"
cleanup() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$TEMP_DB\"" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Creating isolated restore database: $TEMP_DB"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$TEMP_DB\"" >/dev/null
pg_restore --dbname="$TEMP_URL" --no-owner --no-acl --exit-on-error "$DUMP_FILE"

TABLE_COUNT="$(psql "$TEMP_URL" -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('user','account','session','verification','twoFactor','conversations','messages','memory_facts','usage_events','subscriptions','user_profiles')")"
case "$TABLE_COUNT" in
  ''|*[!0-9]*) echo "Could not verify restored tables" >&2; exit 1 ;;
esac
[ "$TABLE_COUNT" -ge 5 ] || { echo "Restore verification found only $TABLE_COUNT expected tables" >&2; exit 1; }
echo "Restore drill passed: $TABLE_COUNT expected tables present"

ROW_COUNTS="$(psql "$TEMP_URL" -Atqc "SELECT json_build_object('users', (SELECT count(*) FROM \"user\"), 'conversations', (SELECT count(*) FROM conversations), 'messages', (SELECT count(*) FROM messages), 'memory_facts', (SELECT count(*) FROM memory_facts), 'subscriptions', (SELECT count(*) FROM subscriptions), 'usage_events', (SELECT count(*) FROM usage_events))::text")"
echo "Restored row counts: $ROW_COUNTS"
