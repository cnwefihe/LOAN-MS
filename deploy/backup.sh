#!/bin/sh
# Nightly backup of the database and the encrypted documents. Keeps 14 days.
# Run from cron on the server; see section 10 of docs/DEPLOY_PROXMOX.md.
# Copy the backup folder off this server too: a backup on the same disk does not survive a failed disk.
set -eu

APP_DIR=${APP_DIR:-/opt/lms}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/pau-lms}
STAMP=$(date +%F)

mkdir -p "$BACKUP_DIR"
cd "$APP_DIR"

docker compose exec -T db pg_dump -U loans -d loans --format=custom --no-owner > "$BACKUP_DIR/db-$STAMP.dump.tmp"
mv "$BACKUP_DIR/db-$STAMP.dump.tmp" "$BACKUP_DIR/db-$STAMP.dump"

docker run --rm --volumes-from pau-lms-app-1 -v "$BACKUP_DIR":/backup alpine \
  tar czf "/backup/documents-$STAMP.tar.gz" -C /app storage

find "$BACKUP_DIR" -type f -mtime +14 -delete
echo "Backup finished: $BACKUP_DIR ($STAMP)"
