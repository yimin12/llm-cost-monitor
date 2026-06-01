// Command mockcache — the centralized mock cache server for the AIBar
// reproduction's "consistency story" demo.
//
// Holds an in-memory map[email]record per vendor. Two daemons hitting the
// same instance see identical SpendUSD AND identical FetchedAt — the
// architectural property the design depends on.
//
// Endpoints:
//
//	GET  /api/v1/vendors/{vendor}/spend?user_email=…
//	POST /api/v1/admin/set    body: {"vendor","email","value","threshold"}
//	GET  /healthz
//
// Bind: 127.0.0.1:18080 by default. Override with LCMBAR_MOCKCACHE_BIND.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type record struct {
	Vendor    string    `json:"vendor"`
	Email     string    `json:"email"`
	Value     float64   `json:"value"`
	Threshold float64   `json:"threshold"`
	FetchedAt time.Time `json:"fetched_at"`
}

type store struct {
	mu sync.RWMutex
	m  map[string]record // key = vendor+"|"+email
}

func (s *store) key(vendor, email string) string {
	return strings.ToLower(vendor) + "|" + strings.ToLower(email)
}

func (s *store) get(vendor, email string) (record, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.m[s.key(vendor, email)]
	return r, ok
}

func (s *store) set(r record) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r.FetchedAt = time.Now().UTC().Truncate(time.Second)
	s.m[s.key(r.Vendor, r.Email)] = r
}

type cachedMetric struct {
	Vendor    string `json:"vendor"`
	CacheHit  bool   `json:"cache_hit"`
	FetchedAt string `json:"fetched_at"`
	Data      struct {
		Value      float64 `json:"value"`
		Dimensions struct {
			Threshold float64 `json:"threshold"`
		} `json:"dimensions"`
	} `json:"data"`
}

func main() {
	bind := envDefault("LCMBAR_MOCKCACHE_BIND", "127.0.0.1:18080")
	flag.StringVar(&bind, "bind", bind, "address to listen on")
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	st := &store{m: map[string]record{}}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"ok":true}`)
	})

	mux.HandleFunc("/api/v1/admin/set", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		var rec record
		if err := json.NewDecoder(r.Body).Decode(&rec); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if rec.Vendor == "" || rec.Email == "" {
			http.Error(w, "vendor and email required", http.StatusBadRequest)
			return
		}
		st.set(rec)
		log.Info("admin set", "vendor", rec.Vendor, "email", rec.Email, "value", rec.Value)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})

	mux.HandleFunc("/api/v1/vendors/", func(w http.ResponseWriter, r *http.Request) {
		// Path: /api/v1/vendors/{vendor}/spend
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/vendors/"), "/")
		if len(parts) < 2 || parts[1] != "spend" {
			http.NotFound(w, r)
			return
		}
		vendor := parts[0]
		email := r.URL.Query().Get("user_email")
		if email == "" {
			http.Error(w, "user_email required", http.StatusBadRequest)
			return
		}
		rec, ok := st.get(vendor, email)
		resp := cachedMetric{
			Vendor:    vendor,
			CacheHit:  ok,
			FetchedAt: rec.FetchedAt.Format(time.RFC3339),
		}
		resp.Data.Value = rec.Value
		resp.Data.Dimensions.Threshold = rec.Threshold
		if !ok {
			// Default: zero spend, "never fetched" sentinel = epoch.
			resp.FetchedAt = time.Unix(0, 0).UTC().Format(time.RFC3339)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})

	srv := &http.Server{
		Addr:              bind,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Info("mockcache listening", "addr", bind)
	if err := srv.ListenAndServe(); err != nil {
		log.Error("server", "err", err)
		os.Exit(1)
	}
}

func envDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
