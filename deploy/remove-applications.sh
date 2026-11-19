#!/bin/sh
# Removes test loan applications and everything recorded about them (see remove-applications.sql).
#
#   ./deploy/remove-applications.sh LMS-261119-005 LMS-261119-010            shows what would be removed; changes nothing
#   ./deploy/remove-applications.sh LMS-261119-005 LMS-261119-010 --confirm  backs up the database, then removes them
#
# Run on the server from the app folder (APP_DIR, default /opt/lms). Staff accounts, profiles and payslips are kept.
set -eu

APP_DIR=${APP_DIR:-/opt/lms}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/pau-lms}
HERE=$(cd "$(dirname "$0")" && pwd)
SQL="$HERE/remove-applications.sql"

confirm=no
refs=""
for a in "$@"; do
  case "$a" in
    --confirm) confirm=yes ;;
    *)
      if ! printf '%s' "$a" | grep -Eq '^LMS-[0-9]{6}-[0-9]{3,}$'; then echo "Not a reference: $a (expected LMS-YYMMDD-NNN)" >&2; exit 1; fi
      refs="$refs $a" ;;
  esac
done
[ -n "$refs" ] || { echo "Give at least one reference, for example: $0 LMS-261119-005" >&2; exit 1; }
[ -f "$SQL" ] || { echo "Missing $SQL" >&2; exit 1; }

cd "$APP_DIR"

values=""
for r in $refs; do values="$values${values:+,}('$r')"; done

run() {
  {
    echo "\\set ON_ERROR_STOP on"
    echo "begin;"
    echo "create temp table rm_refs (ref text) on commit drop;"
    echo "insert into rm_refs values $values;"
    cat "$SQL"
    echo "$1;"
  } | docker compose exec -T db psql -U loans -d loans -q -P pager=off
}

if [ "$confirm" != yes ]; then
  echo "Checking (nothing is changed):"
  run rollback | grep -v '^FILE '
  echo
  echo "Nothing was changed. To remove them, run again with --confirm at the end."
  exit 0
fi

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%F-%H%M%S)
echo "Backing up the database to $BACKUP_DIR/before-removal-$STAMP.dump ..."
docker compose exec -T db pg_dump -U loans -d loans --format=custom --no-owner > "$BACKUP_DIR/before-removal-$STAMP.dump"

echo "Removing:$refs"
out=$(run commit)
printf '%s\n' "$out" | grep -v '^ *FILE '

# Delete the removed documents' encrypted files.
files=$(printf '%s\n' "$out" | sed -n 's/^ *FILE //p')
n=0
for f in $files; do
  case "$f" in *..*|/*) echo "Skipped unexpected file name: $f" >&2; continue ;; esac
  printf '%s' "$f" | grep -Eq '^[A-Za-z0-9/_.-]+$' || { echo "Skipped unexpected file name: $f" >&2; continue; }
  docker compose exec -T app rm -f "/app/storage/$f"
  n=$((n + 1))
done
echo "The next new applications will be given these references again:$refs"
echo "Done. $n document file(s) deleted. The backup taken just before is $BACKUP_DIR/before-removal-$STAMP.dump"
