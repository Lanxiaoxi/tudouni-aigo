package proxy

import (
	"strings"
	"testing"
)

// TestTheSourceNamesTheVariableThatWasUsed: the description is the one place a person
// can see which network path the program took, and it was built from a literal —
// `environment (HTTPS_PROXY)` — while the value could have come from any of the four
// spellings this package reads. On a machine that sets only `HTTP_PROXY`, which is the
// common case on Linux, the screen named a variable that was not set.
//
// Which spelling comes back is the platform's business: on Windows the names are
// case-insensitive, so the first one in the list is the one that matches. The test
// therefore checks the two things that must hold either way — the name that was set is
// in the message, and the one that was not is not.
func TestTheSourceNamesTheVariableThatWasUsed(t *testing.T) {
	clearProxyVariables(t)
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:3456")

	resolved, source := Resolve()
	if resolved == nil || resolved.String() != "http://127.0.0.1:3456" {
		t.Fatalf("resolved = %v, want the value from HTTP_PROXY", resolved)
	}
	if lower := strings.ToLower(source); !strings.Contains(lower, "http_proxy") || strings.Contains(lower, "https_proxy") {
		t.Errorf("source = %q, want it to name HTTP_PROXY rather than one that was not set", source)
	}

	// The refusal names the same one, so the message points at the setting that
	// actually needs fixing.
	clearProxyVariables(t)
	t.Setenv("HTTP_PROXY", "not a url at all")
	problem := Problem()
	if problem == "" {
		t.Fatal("an unusable HTTP_PROXY was not reported")
	}
	if lower := strings.ToLower(problem); !strings.Contains(lower, "http_proxy") || strings.Contains(lower, "https_proxy") {
		t.Errorf("problem = %q, want it to name HTTP_PROXY rather than one that was not set", problem)
	}
}
