package state

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const presetRoutes = `"providers": {
    "cheap": {"base_url": "http://cheap", "api_key": "k", "models": [{"id": "mini", "effort_levels": ["low", "high"]}]},
    "strong": {"base_url": "http://strong", "api_key": "k", "models": [{"id": "big"}]}
  }`

func loadWithSubagents(t *testing.T, section string) (Registry, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	body := "{\n  " + presetRoutes
	if section != "" {
		body += ",\n  \"subagents\": " + section
	}
	body += "\n}\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return Load(path)
}

func TestNoSubagentsSectionIsNoPresets(t *testing.T) {
	registry, err := loadWithSubagents(t, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(registry.Subagents.Presets) != 0 || registry.Subagents.Default != "" {
		t.Errorf("presets = %+v, want none", registry.Subagents)
	}
}

func TestPresetsAreReadInOrderWithTheirDefault(t *testing.T) {
	registry, err := loadWithSubagents(t, `{"default": "deep", "presets": [
      {"name": "fast", "provider": "cheap", "model": "mini", "effort": "LOW", "purpose": "search"},
      {"name": "deep", "provider": "strong", "model": "big"}
    ]}`)
	if err != nil {
		t.Fatal(err)
	}
	got := registry.Subagents
	if got.Default != "deep" || len(got.Presets) != 2 || got.Presets[0].Name != "fast" {
		t.Fatalf("presets = %+v", got)
	}
	if got.Presets[0].Effort != "low" {
		t.Errorf("effort = %q, want the normalised level", got.Presets[0].Effort)
	}
}

func TestPresetProblemsStopTheLoad(t *testing.T) {
	cases := map[string]struct{ section, want string }{
		"unknown route":   {`{"presets": [{"name": "a", "provider": "nope", "model": "mini"}]}`, "nope"},
		"unknown model":   {`{"presets": [{"name": "a", "provider": "cheap", "model": "big"}]}`, "big"},
		"missing model":   {`{"presets": [{"name": "a", "provider": "cheap"}]}`, "provider"},
		"bad effort":      {`{"presets": [{"name": "a", "provider": "cheap", "model": "mini", "effort": "max"}]}`, "max"},
		"duplicate name":  {`{"presets": [{"name": "a", "provider": "cheap", "model": "mini"}, {"name": "a", "provider": "strong", "model": "big"}]}`, "repeats"},
		"bad name":        {`{"presets": [{"name": "a b", "provider": "cheap", "model": "mini"}]}`, "1–32"},
		"default missing": {`{"default": "ghost", "presets": []}`, "ghost"},
		"unknown key":     {`{"presets": [{"name": "a", "provider": "cheap", "model": "mini", "thinking": true}]}`, "thinking"},
		"not a list":      {`{"presets": {}}`, "array"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := loadWithSubagents(t, tc.section)
			if err == nil {
				t.Fatal("the load succeeded")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not mention %q", err.Error(), tc.want)
			}
		})
	}
}

func TestMoreThanTheCapIsRefused(t *testing.T) {
	items := make([]string, 0, MaxSubagentPresets+1)
	for i := 0; i <= MaxSubagentPresets; i++ {
		items = append(items, `{"name": "p`+string(rune('a'+i))+`", "provider": "cheap", "model": "mini"}`)
	}
	_, err := loadWithSubagents(t, `{"presets": [`+strings.Join(items, ",")+`]}`)
	if err == nil || !strings.Contains(err.Error(), "at most") {
		t.Fatalf("err = %v, want the cap refusal", err)
	}
}
