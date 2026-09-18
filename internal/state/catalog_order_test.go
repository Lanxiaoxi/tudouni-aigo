package state

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/config"
)

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestTheFileOrderDecidesTheDefaultRoute — the default is the first **usable**
// route in the file, and the catalogue keeps that order.
//
// The order is the only place a person can state which route they mean to be on,
// and it is the order `/model` lists. A decoded `map[string]any` cannot carry it:
// `range` over a Go map is randomised, so the old code sorted the names and the
// decision went to the alphabet — `zeta` written first lost to `mid` because `m`
// sorts before `z`. Nothing reported that, and the bill lands somewhere else.
func TestTheFileOrderDecidesTheDefaultRoute(t *testing.T) {
	path := writeConfig(t, `{
		"providers": {
			"zeta":  {"base_url": "https://z.example", "api_key": "kz", "models": [{"id": "z-1"}]},
			"alpha": {"base_url": "https://a.example", "api_key": "",   "models": [{"id": "a-1"}]},
			"mid":   {"base_url": "https://m.example", "api_key": "km", "models": [{"id": "m-1"}]}
		}
	}`)
	registry, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	var names []string
	for _, provider := range registry.Providers {
		names = append(names, provider.Name)
	}
	if got := strings.Join(names, ","); got != "zeta,alpha,mid" {
		t.Errorf("the catalogue is ordered %s, want the file's order (zeta,alpha,mid)", got)
	}

	// alpha is skipped because it has no key, so zeta is the first usable route —
	// not `mid`, which is what sorting would have picked.
	if provider, _ := registry.DefaultProvider(); provider.Name != "zeta" {
		t.Errorf("the default route is %q, want zeta (the first usable route in the file)", provider.Name)
	}
	if model, _ := registry.DefaultModel(); model.Qualified() != "zeta/z-1" {
		t.Errorf("the default model is %q, want zeta/z-1", model.Qualified())
	}
}

// TestARouteTheOrderedScanMissedStillAppears pins the fallback: the ordered pass
// is a second reading of the document, and a route it fails to report must still
// reach the catalogue. Dropping a configured route is a worse failure than
// showing it in the wrong place — the user can select the second and not even see
// the first.
func TestARouteTheOrderedScanMissedStillAppears(t *testing.T) {
	cfg := config.UserConfig{
		Providers:     map[string]any{"b": nil, "a": nil},
		ProviderOrder: []string{"a"},
	}
	if got := strings.Join(providerNames(cfg), ","); got != "a,b" {
		t.Errorf("providerNames = %s, want a,b", got)
	}
}
