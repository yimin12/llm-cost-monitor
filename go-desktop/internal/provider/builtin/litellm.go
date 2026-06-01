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

// LiteLLMProvider — talks to a self-hosted LiteLLM proxy.
//
// Endpoint: GET {baseURL}/user/info?user_id=<email>. The response shape has
// drifted across LiteLLM versions, so we accept three known payload shapes
// (mirrors AIBar's parseResponse + budget-exceeded regex path).
type LiteLLMProvider struct {
	baseURL string
	apiKey  string
}

func NewLiteLLMProvider(baseURL, apiKey string) *LiteLLMProvider {
	return &LiteLLMProvider{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
	}
}

func (p *LiteLLMProvider) Info() provider.ProviderInfo {
	return provider.ProviderInfo{
		ID:          "litellm",
		DisplayName: "LiteLLM",
		Unit:        provider.UnitUSD,
		Help:        "self-hosted LiteLLM proxy with virtual keys",
	}
}

func (p *LiteLLMProvider) IsConfigured() bool { return p.baseURL != "" && p.apiKey != "" }

// litellmInfo handles all three known shapes by accepting a permissive struct
// of optional fields. We then normalise into UsageSnapshot.
type litellmInfo struct {
	UserInfo *struct {
		Spend       float64 `json:"spend"`
		MaxBudget   float64 `json:"max_budget"`
		TPMLimit    int64   `json:"tpm_limit"`
		RPMLimit    int64   `json:"rpm_limit"`
		TokensUsed  int64   `json:"tokens_used"`
		TokensLimit int64   `json:"tokens_limit"`
	} `json:"user_info"`

	// flat shape (older LiteLLM)
	Spend       float64 `json:"spend"`
	MaxBudget   float64 `json:"max_budget"`
	TokensUsed  int64   `json:"tokens_used"`
	TokensLimit int64   `json:"tokens_limit"`

	// budget-exceeded text shape (newer)
	Detail string `json:"detail"`
}

func (p *LiteLLMProvider) FetchUsage(ctx context.Context) (provider.UsageSnapshot, error) {
	email, ok := CurrentEmail()
	if !ok {
		return provider.UsageSnapshot{}, provider.ErrNotConfigured
	}
	target := fmt.Sprintf("%s/user/info?user_id=%s", p.baseURL, url.QueryEscape(email))
	body, status, err := p.doGet(ctx, target)
	if err != nil {
		return provider.UsageSnapshot{}, err
	}
	if status >= 400 {
		return provider.UsageSnapshot{}, fmt.Errorf("litellm status %d: %s", status, truncate(string(body), 200))
	}
	var info litellmInfo
	if err := json.Unmarshal(body, &info); err != nil {
		return provider.UsageSnapshot{}, fmt.Errorf("decode: %w", err)
	}
	return parseLiteLLMSnapshot(info), nil
}

func parseLiteLLMSnapshot(info litellmInfo) provider.UsageSnapshot {
	snap := provider.UsageSnapshot{
		ProviderID: "litellm",
		Unit:       provider.UnitUSD,
		FetchedAt:  time.Now(),
	}
	if info.UserInfo != nil {
		snap.SpendUSD = info.UserInfo.Spend
		snap.BudgetUSD = info.UserInfo.MaxBudget
		snap.Tokens = info.UserInfo.TokensUsed
		snap.TokensLimit = info.UserInfo.TokensLimit
	} else {
		snap.SpendUSD = info.Spend
		snap.BudgetUSD = info.MaxBudget
		snap.Tokens = info.TokensUsed
		snap.TokensLimit = info.TokensLimit
	}
	if snap.BudgetUSD > 0 {
		snap.UsagePercent = 100 * snap.SpendUSD / snap.BudgetUSD
	}
	return snap
}

// LiteLLM uses a long-lived API key, NOT the user OIDC token. It bypasses
// the trusted-host allowlist intentionally — the operator wired the URL.
func (p *LiteLLMProvider) doGet(ctx context.Context, target string) ([]byte, int, error) {
	body, status, err := DoGet(ctx, target)
	if err != nil || status != 401 {
		return body, status, err
	}
	// On 401, retry once with the long-lived API key (LiteLLM virtual key).
	return doGetWithBearer(ctx, target, p.apiKey)
}
