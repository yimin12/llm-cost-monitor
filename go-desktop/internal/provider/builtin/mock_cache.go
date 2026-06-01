package builtin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/provider"
)

// MockCacheProvider — the generic central-cache demo provider.
//
// One in-binary provider parameterised by vendor name + Unit replaces what
// AIBar shipped as cursor.go and windsurf.go (95% identical). The "central
// cache consistency" story: two daemons hitting the SAME mock cache server
// see identical SpendUSD AND identical FetchedAt — all sync goes through
// the cache, never peer-to-peer.
//
// Wire format matches tools/mockcache.
type MockCacheProvider struct {
	id       string
	vendor   string
	display  string
	unit     provider.Unit
	endpoint string
}

func NewMockCacheProvider(vendor, displayName string, unit provider.Unit, endpoint string) *MockCacheProvider {
	id := strings.ToLower(vendor)
	return &MockCacheProvider{
		id:       id,
		vendor:   id,
		display:  displayName,
		unit:     unit,
		endpoint: strings.TrimRight(endpoint, "/"),
	}
}

func (m *MockCacheProvider) Info() provider.ProviderInfo {
	return provider.ProviderInfo{
		ID:          m.id,
		DisplayName: m.display,
		Unit:        m.unit,
		Help:        "mock-cache demo: central-cache consistency story",
	}
}

func (m *MockCacheProvider) IsConfigured() bool {
	if m.endpoint == "" {
		return false
	}
	_, ok := CurrentEmail()
	return ok
}

type cachedMetricResponse struct {
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

func (m *MockCacheProvider) FetchUsage(ctx context.Context) (provider.UsageSnapshot, error) {
	email, ok := CurrentEmail()
	if !ok {
		return provider.UsageSnapshot{}, provider.ErrNotConfigured
	}
	target := fmt.Sprintf(
		"%s/api/v1/vendors/%s/spend?user_email=%s",
		m.endpoint, url.PathEscape(m.vendor), url.QueryEscape(email),
	)
	body, status, err := DoGet(ctx, target)
	if err != nil {
		return provider.UsageSnapshot{}, err
	}
	if status >= 400 {
		return provider.UsageSnapshot{}, fmt.Errorf("mock-cache %s status %d: %s", m.vendor, status, truncate(string(body), 200))
	}
	var r cachedMetricResponse
	if err := json.Unmarshal(body, &r); err != nil {
		return provider.UsageSnapshot{}, fmt.Errorf("decode: %w", err)
	}
	fetched, _ := time.Parse(time.RFC3339, r.FetchedAt)
	snap := provider.UsageSnapshot{
		ProviderID: m.id,
		Unit:       m.unit,
		SpendUSD:   r.Data.Value,
		FetchedAt:  fetched,
		CacheHit:   r.CacheHit,
	}
	if t := r.Data.Dimensions.Threshold; t > 0 {
		snap.BudgetUSD = t // upstream-supplied; manager may override
		snap.UsagePercent = 100 * snap.SpendUSD / t
	}
	return snap, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
