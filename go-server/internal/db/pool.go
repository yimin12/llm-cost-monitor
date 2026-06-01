// Package db owns the Postgres pool, migration loop, and the BIGINT-as-int64
// contract. Mirrors server/db.ts so the surface stays obvious during the
// TS→Go migration: migrations directory layout is identical, schema_version
// table is the single source of truth, and one transaction per file.
package db

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"

	"github.com/jackc/pgx/v5/pgxpool"
)

// MigrationStatus mirrors the TS shape so dashboards / log-line consumers
// can flip between implementations without re-tooling.
type MigrationStatus struct {
	AppliedVersion int
	RanThisRun     []int
}

// Open returns a pgx pool. dsn defaults to LCM_SERVER_DSN, then to the same
// loopback default the TS server uses so dev workflows work unmodified.
func Open(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	if dsn == "" {
		dsn = os.Getenv("LCM_SERVER_DSN")
	}
	if dsn == "" {
		dsn = "postgres://lcm:lcm_dev@127.0.0.1:5433/lcm_team_sync"
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	cfg.MaxConns = 5
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}

var migrationFile = regexp.MustCompile(`^(\d+)_.*\.sql$`)

// RunMigrations applies any *.sql under dir whose numeric prefix is greater
// than schema_version's current MAX. Each file runs in its own transaction.
// Order is lexical (numeric prefix) so 0010 runs after 0009 — *not*
// after 0002 — assuming zero-padded file names. Filenames must follow the
// same convention as server-migrations/.
func RunMigrations(ctx context.Context, pool *pgxpool.Pool, dir string) (MigrationStatus, error) {
	if _, err := pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`); err != nil {
		return MigrationStatus{}, fmt.Errorf("ensure schema_version: %w", err)
	}
	var current int
	if err := pool.QueryRow(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_version`).Scan(&current); err != nil {
		return MigrationStatus{}, fmt.Errorf("read schema_version: %w", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return MigrationStatus{}, fmt.Errorf("read migrations dir: %w", err)
	}
	type mig struct {
		version int
		path    string
	}
	pending := []mig{}
	for _, e := range entries {
		m := migrationFile.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		v, err := strconv.Atoi(m[1])
		if err != nil || v <= current {
			continue
		}
		pending = append(pending, mig{version: v, path: filepath.Join(dir, e.Name())})
	}
	sort.Slice(pending, func(i, j int) bool { return pending[i].version < pending[j].version })

	ran := []int{}
	for _, p := range pending {
		sql, err := os.ReadFile(p.path)
		if err != nil {
			return MigrationStatus{}, fmt.Errorf("read %s: %w", p.path, err)
		}
		tx, err := pool.Begin(ctx)
		if err != nil {
			return MigrationStatus{}, fmt.Errorf("begin %s: %w", p.path, err)
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			_ = tx.Rollback(ctx)
			return MigrationStatus{}, fmt.Errorf("apply %s: %w", p.path, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return MigrationStatus{}, fmt.Errorf("commit %s: %w", p.path, err)
		}
		ran = append(ran, p.version)
	}

	var applied int
	if err := pool.QueryRow(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_version`).Scan(&applied); err != nil {
		return MigrationStatus{}, fmt.Errorf("re-read schema_version: %w", err)
	}
	return MigrationStatus{AppliedVersion: applied, RanThisRun: ran}, nil
}

// ErrNoMigrationsDir wraps os.ErrNotExist for callers that want to fall back
// to a different layout (e.g. embedded migrations inside the binary).
var ErrNoMigrationsDir = errors.New("migrations directory not found")
