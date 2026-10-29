package hooks

import (
	"regexp"
	"testing"
)

// mustCompile builds a matcher the way the loader does — through the configuration
// path — because a compiled regexp built any other way would not be testing the
// configuration at all.
func mustCompile(t *testing.T, pattern string) *regexp.Regexp {
	t.Helper()
	raw := `{"version":1,"hooks":{"pre_tool_use":[{"name":"x","command":["sh"],"matcher":"` + pattern + `"}]}}`
	parsed, err := Parse("hooks.json", []byte(raw))
	if err != nil {
		t.Fatalf("matcher %q: %v", pattern, err)
	}
	hook := parsed.Hooks("pre_tool_use")[0]
	if hook.Matcher == nil {
		t.Fatalf("matcher %q compiled to nil", pattern)
	}
	return hook.Matcher
}
