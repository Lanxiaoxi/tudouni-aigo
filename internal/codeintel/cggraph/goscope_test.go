package cggraph

import "testing"

// The rejections here are the difference between a graph an agent can trust and one
// that quietly lies. Each case below was producing a wrong edge on this repository
// before the rule existed, and the numbers in the comments are measured, not
// illustrative.

func TestRejectGoBuiltins(t *testing.T) {
	// `len` alone was 2,090 unresolved refs, `append` 1,017, `make` 340. Before this
	// check any of them that found a same-named project symbol became an edge.
	for _, name := range []string{"len", "append", "make", "string", "error", "nil", "new", "copy"} {
		ref := &pendingRef{Reference: Reference{Name: name, FromLanguage: "go"}}
		if _, reject := rejectRef(ref); !reject {
			t.Errorf("%q: not rejected, but it is a Go predeclared identifier", name)
		}
	}
}

func TestRejectGoKeywords(t *testing.T) {
	for _, name := range []string{"func", "range", "select", "interface"} {
		ref := &pendingRef{Reference: Reference{Name: name, FromLanguage: "go"}}
		if _, reject := rejectRef(ref); !reject {
			t.Errorf("%q: not rejected, but it is a Go keyword", name)
		}
	}
}

// TestRejectStdlibQualifier pins the check that an inverted boolean silently disabled.
//
// Before the fix, `fmt.Sprintf`, `strings.TrimSpace`, `testing.T.Fatalf` and friends
// fell through to name matching and bound to same-named project symbols — the exact
// class of error CodeGraph records as "fiber's 85 context.Context parameters went to a
// Stream.Context method".
func TestRejectStdlibQualifier(t *testing.T) {
	for _, name := range []string{
		"fmt.Sprintf", "strings.TrimSpace", "os.Exit", "errors.As",
		"time.Now", "context.Context", "testing.T", "strconv.Itoa",
		"exec.CommandContext", "filepath.Join", "atomic.Bool", "sql.DB",
	} {
		ref := &pendingRef{Reference: Reference{Name: name, FromLanguage: "go"}}
		if reason, reject := rejectRef(ref); !reject {
			t.Errorf("%q: not rejected (reason %q), but its qualifier is standard library", name, reason)
		}
	}
}

// A project package may legitimately have the same last segment as a stdlib one, and
// the qualifier check must not eat it. `internal` is not in the list precisely because
// it is a common first-party name.
func TestRejectLeavesProjectQualifiersAlone(t *testing.T) {
	for _, name := range []string{
		"tools.Tool", "agent.Agent", "cggraph.Open", "server.Start",
		"foo.Bar", "internal.Thing",
	} {
		ref := &pendingRef{Reference: Reference{Name: name, FromLanguage: "go"}}
		if reason, reject := rejectRef(ref); reject {
			t.Errorf("%q: rejected (%q), but its qualifier is not standard library", name, reason)
		}
	}
}

// A bare name is never rejected on qualifier grounds: it has no qualifier.
func TestRejectBareNamePasses(t *testing.T) {
	ref := &pendingRef{Reference: Reference{Name: "Run", FromLanguage: "go"}}
	if reason, reject := rejectRef(ref); reject {
		t.Errorf("bare name rejected: %q", reason)
	}
}

// Non-Go references are left to their own language tier; only Go rules apply here.
func TestRejectOnlyAppliesToGo(t *testing.T) {
	ref := &pendingRef{Reference: Reference{Name: "len", FromLanguage: "typescript"}}
	if reason, reject := rejectRef(ref); reject {
		t.Errorf("typescript `len` rejected by a Go rule: %q", reason)
	}
}

func TestGoVisibleAcrossFiles(t *testing.T) {
	// Exported: nameable from anywhere.
	if !GoVisibleAcrossFiles("Tool", "a/x.go", "b/y.go") {
		t.Error("exported Tool should be visible across packages")
	}
	// Unexported: package-private, and a package is a directory.
	if GoVisibleAcrossFiles("helper", "a/x.go", "b/y.go") {
		t.Error("unexported helper must not cross package boundaries")
	}
	if !GoVisibleAcrossFiles("helper", "a/x.go", "a/z.go") {
		t.Error("unexported helper should be visible within its package")
	}
}

func TestIsGoExported(t *testing.T) {
	cases := map[string]bool{
		"Tool": true, "tool": false, "_hidden": false, "Ärger": true, "ärger": false,
	}
	for name, want := range cases {
		if got := IsGoExported(name); got != want {
			t.Errorf("IsGoExported(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestIsGoStandardLibraryImport(t *testing.T) {
	cases := map[string]bool{
		"fmt": true, "net/http": true, "encoding/json": true,
		"github.com/x/y": false, "gopkg.in/yaml.v3": false,
		"": false,
	}
	for path, want := range cases {
		if got := IsGoStandardLibraryImport(path); got != want {
			t.Errorf("IsGoStandardLibraryImport(%q) = %v, want %v", path, got, want)
		}
	}
}
