#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"

# Used only for an explicitly requested operational inspection. It keeps the
# cron container available for SSH while leaving the mounted recovery points
# untouched. Normal scheduled runs do not set this variable.
if [ "${INSPECTION_MODE:-false}" = "true" ]; then
  echo "Backup inspection mode active; no backup will be created."
  exec sleep "${INSPECTION_DURATION_SECONDS:-1800}"
fi

DAILY_DIR="$BACKUP_DIR/daily"
MONTHLY_DIR="$BACKUP_DIR/monthly"
DATE_UTC="$(date -u +%Y-%m-%d)"
MONTH_UTC="$(date -u +%Y-%m)"
DAILY_FILE="$DAILY_DIR/vibhavgpt-$DATE_UTC.dump"
MONTHLY_FILE="$MONTHLY_DIR/vibhavgpt-$MONTH_UTC.dump"
LOCK_DIR="$BACKUP_DIR/.backup-lock"

mkdir -p "$DAILY_DIR" "$MONTHLY_DIR"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "A backup is already running; exiting safely." >&2
  exit 1
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

TMP_FILE="$DAILY_FILE.tmp"
rm -f "$TMP_FILE"
echo "Creating PostgreSQL dump: $DAILY_FILE"
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl --file="$TMP_FILE"
mv "$TMP_FILE" "$DAILY_FILE"
sha256sum "$DAILY_FILE" > "$DAILY_FILE.sha256"

# The first daily dump of each month is also the monthly recovery point.
if [ "$(date -u +%d)" = "01" ] || [ ! -f "$MONTHLY_FILE" ]; then
  cp "$DAILY_FILE" "$MONTHLY_FILE"
  sha256sum "$MONTHLY_FILE" > "$MONTHLY_FILE.sha256"
fi

# Keep the newest 30 daily and 12 monthly recovery points (and their checksums).
find "$DAILY_DIR" -type f -name '*.dump' -print | sort -r | awk 'NR > 30 {print}' | while IFS= read -r f; do
  rm -f "$f" "$f.sha256"
done
find "$MONTHLY_DIR" -type f -name '*.dump' -print | sort -r | awk 'NR > 12 {print}' | while IFS= read -r f; do
  rm -f "$f" "$f.sha256"
done

echo "Backup complete: $(du -h "$DAILY_FILE" | awk '{print $1}')"

if [ "${RUN_RESTORE_DRILL:-false}" = "true" ]; then
  DUMP_FILE="$DAILY_FILE" /usr/local/bin/restore-drill
fi
