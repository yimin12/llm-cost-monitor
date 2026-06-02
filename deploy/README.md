# Deploying the team-sync database + Core Service (cheap single-VPS)

This runbook stands up the **state-recording Postgres DB** and the team-sync
Core Service on one small always-on VPS, for ~€4/month. It reuses the repo's
existing Docker stack (`docker-compose.yml`) plus the production overlay
(`docker-compose.prod.yml`). No application code changes.

> **Why this shape:** the workload is tiny and read-heavy (daily batched writes,
> ~240 MB/yr for 10 nodes/3 users — see the plan). A €3.49–€3.79 Hetzner CX-class
> VPS is the cheapest option that is always-on, uncapped, and backup-capable.
> Free serverless tiers (Neon/Supabase) are $0 but cap storage and cold-start /
> pause — not chosen for a real team needing uptime.

## What the DB records
Per-node token counts (input/output/cache/reasoning) and per-event & per-day
**cost in micro-USD (BIGINT)**, summed across nodes per user and per team
(tables `usage_events`, `event_daily_rollup`, `daily_aggregates`, `nodes`,
`team_members`). Schema + perf indexes live in `server-migrations/` and apply
automatically on server boot (`runServerMigrations`).

## 1. Provision the VPS
- **EU:** Hetzner Cloud **CX22** (2 vCPU / 4 GB / 40 GB NVMe, ~€3.79) or **CX23** (~€3.49).
- **US:** Hetzner regions **Ashburn, VA** or **Hillsboro, OR** — US has only the
  CPX/CCX line, so use **CPX21** (3 vCPU / 4 GB, ~$8/mo, recommended) or **CPX11**
  (2 vCPU / 2 GB, ~$5.50/mo; if you use the 2 GB box, lower Postgres's `memory: 1g`
  limit in `docker-compose.yml` so all three containers fit). US traffic cap is
  1 TB — far more than this workload uses. Easiest non-Hetzner US alternative:
  AWS Lightsail 2 GB ($7/mo, built-in snapshots).
- Ubuntu 24.04 LTS, region nearest your team.
- Install Docker Engine + the compose plugin (`get.docker.com`).
- **Cloud Firewall**: allow inbound TCP **443** and **22** (SSH from your IP only); deny the rest.
- Point DNS `A`/`AAAA` for your domain (e.g. `sync.example.com`) at the VPS IP.

## 2. Get the code + configure secrets
```sh
git clone https://github.com/yimin12/llm-cost-monitor.git /opt/llm-cost-monitor
cd /opt/llm-cost-monitor
cp deploy/env.example .env
$EDITOR .env            # set POSTGRES_PASSWORD, LCM_SERVER_AUDIENCE, LCM_SYNC_DOMAIN, LCM_ACME_EMAIL
```
`.env` is gitignored (`.env*`). `LCM_SERVER_AUDIENCE` = the desktop OAuth
client_id (`src/shared/oauth-config.ts`).

## 3. Bring it up
```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile server up -d
```
This starts **postgres** (data on the named volume `lcm_pgdata`), the **server**
(self-migrates 0001→latest on boot), and **caddy** (fetches a Let's Encrypt cert
and proxies 443 → server:4017). Verify:
```sh
curl https://sync.example.com/healthz      # -> {"ok":true}
docker compose logs server | grep -i migrat # migrations applied
```

## 4. Automated daily backups
```sh
apt-get install -y rclone
rclone config                               # create the remote named in BACKUP_RCLONE_REMOTE (B2 or R2)
crontab -e
# 15 3 * * *  cd /opt/llm-cost-monitor && ./deploy/backup.sh >> /var/log/lcm-backup.log 2>&1
```
Verify a restore once:
```sh
docker exec llm-cost-monitor-postgres psql -U lcm -c 'CREATE DATABASE lcm_team_sync_restore'
rclone cat <remote>/lcm_team_sync-<date>.sql.gz | gunzip \
  | docker exec -i llm-cost-monitor-postgres psql -U lcm -d lcm_team_sync_restore
```

## 5. Point desktop clients at it
In each desktop app's team-sync settings, set the server URL to
`https://sync.example.com` (persisted as `teamSync.serverUrl`, `src/shared/sync.ts`).
Trigger a sync and confirm the dashboard shows token + cost merged across nodes.

## Operate
- Update: `git pull && docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile server up -d --build`
- Logs: `docker compose logs -f server`
- Survives reboot via `restart: unless-stopped`; data persists in `lcm_pgdata`.

## Scaling / exit
Outgrowing one VPS (>~50 users or you want HA)? Move `LCM_SERVER_DSN` to a
managed Postgres (Neon paid / RDS) — no app code change.
