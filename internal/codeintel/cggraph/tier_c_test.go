package cggraph

import "testing"

// The C/C++ tier's rules. The one that matters is translation-unit locality: without it,
// a cross-file call binds to a same-named `static` in an unrelated file — the failure the
// reference implementation measured at 145 edges on a 2,109-file C tree.

// TestCStaticFunctionIsTranslationUnitLocal is the core rule.
func TestCStaticFunctionIsTranslationUnitLocal(t *testing.T) {
	// `helper` is static in a.c; `other.c` neither includes it nor is it.
	aFile := writeTempSource(t, "c/a.c", `static void helper(void) { }
void caller(void) { helper(); }
`)
	otherFile := writeTempSource(t, "c/other.c", `void other(void) { helper(); }
`)

	tier := &cTier{language: "c"}
	cand := Candidate{
		Name: "helper", Kind: "function", Language: "c",
		FilePath: aFile, StartLine: 1, Visibility: "private",
	}

	// Same file: visible.
	if !tier.Visible(&cand, &pendingRef{Reference: Reference{
		FromFileName: aFile, FromLanguage: "c",
	}}) {
		t.Error("a static function should be visible in its own file")
	}
	// Another unit: not visible.
	if tier.Visible(&cand, &pendingRef{Reference: Reference{
		FromFileName: otherFile, FromLanguage: "c",
	}}) {
		t.Error("a static function must not be visible from another translation unit")
	}
}

// A header's declaration is shared, so a header-defined type is visible everywhere.
func TestCHeaderTypeIsShared(t *testing.T) {
	header := writeTempSource(t, "c/types.h", `struct Point { int x; int y; };
`)
	aFile := writeTempSource(t, "c/a.c", `#include "types.h"
`)
	tier := &cTier{language: "c"}

	cand := Candidate{Name: "Point", Kind: "struct", Language: "c", FilePath: header}
	// From a unit that includes it, and from one that does not — a header type is not
	// unit-local either way, because the header itself owns nothing.
	other := writeTempSource(t, "c/z.c", `int z;`)
	if !tier.Visible(&cand, &pendingRef{Reference: Reference{
		FromFileName: aFile, FromLanguage: "c",
	}}) {
		t.Error("a header type should be visible to an including unit")
	}
	if !tier.Visible(&cand, &pendingRef{Reference: Reference{
		FromFileName: other, FromLanguage: "c",
	}}) {
		t.Error("a header type is not unit-local, so it stays visible")
	}
}

// TestCStaticReachableThroughInclude covers the hiredis pattern: `async.c` includes
// `dict.c`, so `dict.c`'s static functions are reachable from `async.c`.
func TestCStaticReachableThroughInclude(t *testing.T) {
	dir := t.TempDir()
	// Write both files so the include can be resolved on disk.
	dict := writeTempSourceAt(t, dir, "dict.c", `static int dict_expand(void) { return 0; }
`)
	async := writeTempSourceAt(t, dir, "async.c", `#include "dict.c"
void use(void) { dict_expand(); }
`)

	tier := &cTier{language: "c"}
	cand := Candidate{
		Name: "dict_expand", Kind: "function", Language: "c",
		FilePath: dict, StartLine: 1,
	}
	if !tier.Visible(&cand, &pendingRef{Reference: Reference{
		FromFileName: async, FromLanguage: "c",
	}}) {
		t.Error("a static function should be reachable from a unit that includes its file")
	}
	_ = dir
}

// A non-static function in a source file is not unit-local: it has external linkage.
func TestCNonStaticFunctionIsVisible(t *testing.T) {
	aFile := writeTempSource(t, "c/a.c", `int helper(void) { return 0; }
`)
	other := writeTempSource(t, "c/b.c", `int b;`)
	tier := &cTier{language: "c"}

	cand := Candidate{Name: "helper", Kind: "function", Language: "c", FilePath: aFile, StartLine: 1}
	if !tier.Visible(&cand, &pendingRef{Reference: Reference{
		FromFileName: other, FromLanguage: "c",
	}}) {
		t.Error("a non-static function has external linkage and is visible everywhere")
	}
}

// A struct defined in a source file is that unit's.
func TestCSourceTypeIsUnitLocal(t *testing.T) {
	aFile := writeTempSource(t, "c/a.c", `struct Local { int v; };
`)
	other := writeTempSource(t, "c/b.c", `int b;`)
	tier := &cTier{language: "c"}

	cand := Candidate{Name: "Local", Kind: "struct", Language: "c", FilePath: aFile, StartLine: 1}
	if tier.Visible(&cand, &pendingRef{Reference: Reference{
		FromFileName: other, FromLanguage: "c",
	}}) {
		t.Error("a type defined in a source file is translation-unit-local")
	}
}

// An anonymous namespace's members are the unit's.
func TestCppAnonymousNamespaceIsUnitLocal(t *testing.T) {
	aFile := writeTempSource(t, "c/a.cpp", `namespace {
void helper() { }
}
`)
	other := writeTempSource(t, "c/b.cpp", `int b;`)
	tier := &cTier{language: "cpp"}

	cand := Candidate{
		Name: "helper", Kind: "function", Language: "cpp",
		FilePath: aFile, StartLine: 2, QualifiedName: "helper",
	}
	if tier.Visible(&cand, &pendingRef{Reference: Reference{
		FromFileName: other, FromLanguage: "cpp",
	}}) {
		t.Error("a member of an anonymous namespace is translation-unit-local")
	}
}

// A C++ qualified reference is narrowed to the namespace or class it names.
func TestCppNarrowByNamespace(t *testing.T) {
	tier := &cTier{language: "cpp"}
	ref := &pendingRef{Reference: Reference{
		Name: "fs::open", FromLanguage: "cpp", FromFileName: "a.cpp",
	}}
	candidates := []Candidate{
		{ID: "a", Name: "open", QualifiedName: "fs::open", FilePath: "fs.cpp"},
		{ID: "b", Name: "open", QualifiedName: "net::open", FilePath: "net.cpp"},
	}
	narrowed, applied := tier.Narrow(ref, nil, candidates)
	if !applied {
		t.Fatal("a namespace-qualified reference should narrow")
	}
	if len(narrowed) != 1 || narrowed[0].ID != "a" {
		t.Fatalf("narrowed = %+v, want only fs::open", narrowed)
	}
}

// A plain C reference has no qualifier and is never narrowed.
func TestCTierDoesNotNarrowPlainNames(t *testing.T) {
	tier := &cTier{language: "c"}
	ref := &pendingRef{Reference: Reference{Name: "helper", FromLanguage: "c"}}
	if _, applied := tier.Narrow(ref, nil, []Candidate{{ID: "a"}}); applied {
		t.Error("a bare C name must not be narrowed")
	}
}

func TestCFunctionIsStatic(t *testing.T) {
	staticFn := writeTempSource(t, "c/s.c", `static void hidden(void) { }
`)
	plainFn := writeTempSource(t, "c/p.c", `void visible(void) { }
`)
	// A wrapped declaration: the modifier is on the previous line.
	wrapped := writeTempSource(t, "c/w.c", `static void
wrapped(void) { }
`)
	// A name containing "static" must not match.
	trap := writeTempSource(t, "c/t.c", `void is_static_thing(void) { }
`)

	cases := []struct {
		file string
		line int
		want bool
	}{
		{staticFn, 1, true},
		{plainFn, 1, false},
		{wrapped, 2, true},
		{trap, 1, false},
	}
	for _, c := range cases {
		cand := &Candidate{FilePath: c.file, StartLine: c.line}
		if got := cFunctionIsStatic(cand); got != c.want {
			t.Errorf("%s:%d isStatic = %v, want %v", c.file, c.line, got, c.want)
		}
	}
}

func TestCIncludeTargets(t *testing.T) {
	file := writeTempSource(t, "c/x.c", `#include <stdio.h>
#include "local.h"
  #  include "spaced.h"
`)
	got := cIncludeTargets(file)
	want := map[string]bool{"stdio.h": true, "local.h": true, "spaced.h": true}
	if len(got) != len(want) {
		t.Fatalf("targets = %v, want %v", got, want)
	}
	for _, include := range got {
		if !want[include] {
			t.Errorf("unexpected include %q", include)
		}
	}
}

func TestCStdlibNames(t *testing.T) {
	tier := &cTier{language: "c"}
	for _, name := range []string{"printf", "malloc", "size_t", "NULL", "memcpy"} {
		if !tier.IsBuiltin(name) {
			t.Errorf("%q not recognised as a C standard-library name", name)
		}
	}
	for _, name := range []string{"my_helper", "Config", "parse_request"} {
		if tier.IsBuiltin(name) {
			t.Errorf("%q wrongly classified as a standard-library name", name)
		}
	}
}
