package cggraph

import "testing"

// The import table is the strongest fact available for a Go qualified reference, so
// these tests pin the mapping that makes it usable: import path → directory, and
// alias → local name.

func TestImportLocalName(t *testing.T) {
	cases := []struct {
		imp  Import
		want string
	}{
		{Import{Path: "fmt"}, "fmt"},
		{Import{Path: "net/http"}, "http"},
		{Import{Path: "github.com/x/y/v2"}, "y"},
		{Import{Path: "github.com/x/y/v2", Alias: "why"}, "why"},
		{Import{Path: "gopkg.in/yaml.v3"}, "yaml.v3"},
		{Import{Path: "example.com/foo/"}, "foo"},
	}
	for _, c := range cases {
		if got := c.imp.LocalName(); got != c.want {
			t.Errorf("%+v.LocalName() = %q, want %q", c.imp, got, c.want)
		}
	}
}

func TestParseImportSpec(t *testing.T) {
	cases := []struct {
		name, signature string
		want            Import
	}{
		{"context", `"context"`, Import{Path: "context"}},
		{"github.com/x/y", `ctxwin "github.com/x/y"`, Import{Path: "github.com/x/y", Alias: "ctxwin"}},
		{"embed", `. "embed"`, Import{Path: "embed", DotImport: true}},
		{"net/http/pprof", `_ "net/http/pprof"`, Import{Path: "net/http/pprof", Blank: true}},
		{"os", `import "os"`, Import{Path: "os"}},
	}
	for _, c := range cases {
		got := ParseImportSpec(c.name, c.signature)
		if got != c.want {
			t.Errorf("ParseImportSpec(%q,%q)\n got %+v\nwant %+v", c.name, c.signature, got, c.want)
		}
	}
}

func TestImportPathToDir(t *testing.T) {
	const prefix = "github.com/Lanxiaoxi/tudouni-aigo"
	cases := []struct {
		path, want string
	}{
		{"github.com/Lanxiaoxi/tudouni-aigo/internal/tools", "internal/tools"},
		{"github.com/Lanxiaoxi/tudouni-aigo", "."},
		// Outside the module: a dependency has no directory here.
		{"github.com/stretchr/testify/assert", ""},
		{"fmt", ""},
	}
	for _, c := range cases {
		if got := importPathToDir(c.path, prefix); got != c.want {
			t.Errorf("importPathToDir(%q) = %q, want %q", c.path, got, c.want)
		}
	}
}

func TestNarrowToImport(t *testing.T) {
	ref := &pendingRef{Reference: Reference{
		Name: "tools.Tool", FromLanguage: "go", FromFileName: `internal/agent/agent.go`,
	}}
	imports := map[string]Import{
		"tools": {Path: "github.com/Lanxiaoxi/tudouni-aigo/internal/tools"},
	}
	candidates := []Candidate{
		{ID: "a", Name: "Tool", FilePath: `internal/tools/tool.go`},
		{ID: "b", Name: "Tool", FilePath: `internal/mcp/toolset.go`},
	}
	narrowed, applied := narrowToImport(ref, imports, candidates, "github.com/Lanxiaoxi/tudouni-aigo")
	if !applied {
		t.Fatal("narrowing did not apply; the qualifier is an import")
	}
	if len(narrowed) != 1 || narrowed[0].ID != "a" {
		t.Fatalf("narrowed = %+v, want only candidate a", narrowed)
	}
}

// A qualifier that is a local variable must NOT be treated as an import: `server.Start`
// is a method call, and narrowing it to a package would empty the candidate set.
func TestNarrowToImportSkipsLocals(t *testing.T) {
	ref := &pendingRef{Reference: Reference{
		Name: "server.Start", FromLanguage: "go", FromFileName: "main.go",
	}}
	imports := map[string]Import{"fmt": {Path: "fmt"}}
	candidates := []Candidate{{ID: "a", Name: "Start", FilePath: "server.go"}}
	narrowed, applied := narrowToImport(ref, imports, candidates, "")
	if applied {
		t.Fatal("narrowing applied to a non-import qualifier")
	}
	if len(narrowed) != 1 {
		t.Fatalf("candidates changed: %+v", narrowed)
	}
}

// A qualified reference to a member of an imported package that is outside the tree
// narrows to nothing, and the caller records it unresolved rather than guessing.
func TestNarrowToImportExcludesOutsideRepo(t *testing.T) {
	ref := &pendingRef{Reference: Reference{
		Name: "assert.Equal", FromLanguage: "go", FromFileName: "x_test.go",
	}}
	imports := map[string]Import{"assert": {Path: "github.com/stretchr/testify/assert"}}
	candidates := []Candidate{{ID: "a", Name: "Equal", FilePath: "x_test.go"}}
	narrowed, applied := narrowToImport(
		ref, imports, candidates, "github.com/Lanxiaoxi/tudouni-aigo")
	if !applied {
		t.Fatal("narrowing did not apply for an out-of-repo import")
	}
	if len(narrowed) != 0 {
		t.Fatalf("narrowed = %+v, want empty (the package is not in this tree)", narrowed)
	}
}
