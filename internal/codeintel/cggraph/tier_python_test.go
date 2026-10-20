package cggraph

import "testing"

// The Python tier's rules, pinned. These are the checks that decide whether the tier
// abstraction is the right shape: every rule here is something the neutral resolver loop
// cannot know on its own.

func TestPythonVisible(t *testing.T) {
	tier := &pythonTier{}

	cases := []struct {
		name     string
		candFile string
		refFile  string
		want     bool
		why      string
	}{
		{"helper", "pkg/a.py", "pkg/a.py", true, "same module"},
		{"public", "pkg/a.py", "pkg/b.py", true, "public name crosses modules"},
		{"_private", "pkg/a.py", "pkg/b.py", false, "underscore prefix is module-private"},
		{"_private", "pkg/a.py", "pkg/a.py", true, "same module sees its own private name"},
		{"__init__", "pkg/a.py", "pkg/b.py", true, "dunder is a protocol hook"},
		{"__str__", "pkg/a.py", "pkg/b.py", true, "dunder is a protocol hook"},
		{"_x", "pkg/__init__.py", "pkg/sub/__init__.py", false, "underscore across packages"},
	}
	for _, c := range cases {
		cand := Candidate{Name: c.name, FilePath: c.candFile}
		ref := &pendingRef{Reference: Reference{FromFileName: c.refFile, FromLanguage: "python"}}
		if got := tier.Visible(&cand, ref); got != c.want {
			t.Errorf("%s defined in %s, used in %s: Visible=%v, want %v (%s)",
				c.name, c.candFile, c.refFile, got, c.want, c.why)
		}
	}
}

func TestPythonModuleDir(t *testing.T) {
	cases := map[string]string{
		"app.api.routes": "app/api/routes",
		"app":            "app",
		".relative":      "",
		"..parent":       "",
		"":               "",
	}
	for in, want := range cases {
		if got := pythonModuleDir(in); got != want {
			t.Errorf("pythonModuleDir(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestPythonInModuleDir pins the module-vs-package rule: `a.b.c` names either
// `a/b/c.py` or the package `a/b/c/__init__.py`, and nothing else.
func TestPythonInModuleDir(t *testing.T) {
	cases := []struct {
		file, dir string
		want      bool
	}{
		{"app/api/routes.py", "app/api/routes", true},
		{"app/api/routes/__init__.py", "app/api/routes", true},
		{"src/app/api/routes.py", "app/api/routes", true},
		// A sibling module in the same package is NOT the module itself.
		{"app/api/other.py", "app/api/routes", false},
		{"app/api/routes_test.py", "app/api/routes", false},
		// The package's own child module is not the package.
		{"app/api/routes/sub.py", "app/api/routes", false},
	}
	for _, c := range cases {
		if got := pythonInModuleDir(c.file, c.dir); got != c.want {
			t.Errorf("pythonInModuleDir(%q, %q) = %v, want %v", c.file, c.dir, got, c.want)
		}
	}
}

func TestPythonNarrow(t *testing.T) {
	tier := &pythonTier{}
	ref := &pendingRef{Reference: Reference{
		Name: "routes.handler", FromLanguage: "python", FromFileName: "app/main.py",
	}}
	imports := map[string]Import{
		"routes": {Path: "app.api.routes"},
	}
	candidates := []Candidate{
		{ID: "a", Name: "handler", FilePath: "app/api/routes.py"},
		{ID: "b", Name: "handler", FilePath: "app/other/routes.py"},
	}
	narrowed, applied := tier.Narrow(ref, imports, candidates)
	if !applied {
		t.Fatal("narrowing did not apply; the qualifier is an import")
	}
	if len(narrowed) != 1 || narrowed[0].ID != "a" {
		t.Fatalf("narrowed = %+v, want only candidate a", narrowed)
	}
}

// A relative import has no fixed path, so narrowing must decline rather than empty the
// set — an empty result would be reported as unresolved, which is wrong for `from . import x`.
func TestPythonNarrowSkipsRelativeImport(t *testing.T) {
	tier := &pythonTier{}
	ref := &pendingRef{Reference: Reference{
		Name: "x.y", FromLanguage: "python", FromFileName: "app/main.py",
	}}
	imports := map[string]Import{"x": {Path: ".sibling"}}
	candidates := []Candidate{{ID: "a", Name: "y", FilePath: "app/sibling.py"}}
	narrowed, applied := tier.Narrow(ref, imports, candidates)
	if applied {
		t.Fatal("narrowing applied to a relative import, which has no fixed path")
	}
	if len(narrowed) != 1 {
		t.Fatalf("candidates changed: %+v", narrowed)
	}
}

// A qualifier that is not an import is a local variable or a class in this module; it
// must not narrow.
func TestPythonNarrowSkipsNonImport(t *testing.T) {
	tier := &pythonTier{}
	ref := &pendingRef{Reference: Reference{Name: "obj.method", FromLanguage: "python"}}
	candidates := []Candidate{{ID: "a", Name: "method", FilePath: "x.py"}}
	if _, applied := tier.Narrow(ref, map[string]Import{}, candidates); applied {
		t.Fatal("narrowing applied to a non-import qualifier")
	}
}

// `self.m` resolves on the enclosing class, which is the one receiver inference Python
// needs and the one that pays.
func TestPythonReceiverTypeSelf(t *testing.T) {
	tier := &pythonTier{}
	src := `import os

class Outer:
    def method(self):
        pass

class Inner(Outer):
    def first(self):
        self.method()

    def second(self):
        self.other()

def free():
    self.method()
`
	file := &sourceFile{path: "m.py", text: src, read: true}

	cases := []struct {
		line int
		want string
	}{
		{8, "Inner"},  // inside Inner.first
		{11, "Inner"}, // inside Inner.second
	}
	for _, c := range cases {
		ref := &pendingRef{Reference: Reference{
			Name: "self.method", FromLanguage: "python", Line: c.line,
		}}
		if got := tier.ReceiverType(ref, file); got != c.want {
			t.Errorf("line %d: ReceiverType = %q, want %q", c.line, got, c.want)
		}
	}

	// A receiver other than self/cls is not inferred.
	ref := &pendingRef{Reference: Reference{Name: "obj.method", FromLanguage: "python", Line: 8}}
	if got := tier.ReceiverType(ref, file); got != "" {
		t.Errorf("obj.method receiver inferred as %q, want empty", got)
	}
}

// A nested class wins over its enclosing one: the innermost declaration is the type.
func TestEnclosingPythonClassNested(t *testing.T) {
	src := `class Outer:
    class Inner:
        def m(self):
            self.x()

    def n(self):
        self.y()
`
	file := &sourceFile{path: "m.py", text: src, read: true}

	if got, _ := enclosingPythonClass(file.Text(), 4); got != "Inner" {
		t.Errorf("line 4: enclosing class = %q, want Inner", got)
	}
	if got, _ := enclosingPythonClass(file.Text(), 7); got != "Outer" {
		t.Errorf("line 7: enclosing class = %q, want Outer", got)
	}
	// Outside every class.
	if _, ok := enclosingPythonClass(file.Text(), 1); ok {
		t.Error("line 1 reported an enclosing class")
	}
}

func TestPythonBuiltins(t *testing.T) {
	tier := &pythonTier{}
	for _, name := range []string{"len", "print", "None", "ValueError", "isinstance", "str"} {
		if !tier.IsBuiltin(name) {
			t.Errorf("%q not recognised as a Python builtin", name)
		}
	}
	for _, name := range []string{"fetch", "UserService", "main", "Handler"} {
		if tier.IsBuiltin(name) {
			t.Errorf("%q wrongly classified as a Python builtin", name)
		}
	}
}
