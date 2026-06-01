#!/usr/bin/env bash
# Daily logical backup of the team-sync database to cheap object storage.
#
# Dumps lcm_team_sync from the running postgres container, gzips it, uploads it
# to an rclone remote (Backblaze B2 / Cloudflare R2 — ~$0 at this data size),
# and prunes dumps older than BACKUP_RETENTION_DAYS.
#
# Install once (on the VPS):
#   rclone config                       # set up the remote named in .env
#   crontab -e                          # add:
#   15 3 * * *  cd /opt/llm-cost-monitor && ./deploy/backup.sh >> /var/log/lcm-backup.log 2>&1
#
# Restore (into a scratch DB to verify):
#   rclone cat b2:.../lcm_team_sync-YYYY-MM-DD.sql.gz | gunzip \
#     | docker exec -i llm-cost-monitor-postgres psql -U lcm -d lcm_team_sync_restore
set -euo pipefail

cd "$(dirname "$0")/.."                 # repo root (where .env lives)
# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a

: "${POSTGRES_USER:=lcm}"
: "${BACKUP_RCLONE_REMOTE:?set BACKUP_RCLONE_REMOTE in .env}"
: "${BACKUP_RETENTION_DAYS:=30}"

CONTAINER="${POSTGRES_CONTAINER:-llm-cost-monitor-postgres}"
DB="lcm_team_sync"
STAMP="$(date -u +%Y-%m-%d)"
FILE="${DB}-${STAMP}.sql.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[backup] dumping ${DB} from ${CONTAINER} ..."
docker exec "$CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$DB" --no-owner --no-privileges \
  | gzip -9 > "${TMP}/${FILE}"

SIZE="$(du -h "${TMP}/${FILE}" | cut -f1)"
echo "[backup] uploading ${FILE} (${SIZE}) to ${BACKUP_RCLONE_REMOTE} ..."
rclone copy "${TMP}/${FILE}" "${BACKUP_RCLONE_REMOTE}/" --progress

echo "[backup] pruning dumps older than ${BACKUP_RETENTION_DAYS} days ..."
rclone delete "${BACKUP_RCLONE_REMOTE}/" --min-age "${BACKUP_RETENTION_DAYS}d" --include "${DB}-*.sql.gz"

echo "[backup] done: ${FILE}"
