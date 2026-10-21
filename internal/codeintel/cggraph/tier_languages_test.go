package cggraph

import "testing"

// Tests for the Rust, Java, Kotlin and JS tiers. Each pins the rule that makes its
// language's scoping different from Go's — the rules the neutral loop cannot know.

// ---------------------------------------------------------------- Rust ----

func TestRustModuleDir(t *testing.T) {
	cases := map[string]string{
		"src/runtime/mod.rs":     "src/runtime",
		"src/lib.rs":             "src",
		"src/main.rs":            "src",
		"src/runtime/task.rs":    "src/runtime/task",
		"src/build/patch/mod.rs": "src/build/patch",
	}
	for in, want := range cases {
		if got := rustModuleDir(in); got != want {
			t.Errorf("rustModuleDir(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestRustVisiblePrivateItem is the rule that matters: a non-pub item is visible to its
// own module and the modules inside it, never to a sibling.
func TestRustVisiblePrivateItem(t *testing.T) {
	tier := &rustTier{}
	cand := Candidate{
		Name: "Result", Kind: "type_alias", Language: "rust",
		FilePath: "src/build/patch.rs", Visibility: "private",
	}

	cases := []struct {
		refFile string
		want    bool
		why     string
	}{
		{"src/build/patch.rs", true, "own module"},
		{"src/build/patch/inner.rs", true, "module inside it"},
		{"src/build/other.rs", false, "sibling module"},
		{"src/other.rs", false, "unrelated module"},
	}
	for _, c := range cases {
		ref := &pendingRef{Reference: Reference{FromFileName: c.refFile, FromLanguage: "rust"}}
		if got := tier.Visible(&cand, ref); got != c.want {
			t.Errorf("%s (%s): Visible=%v, want %v", c.refFile, c.why, got, c.want)
		}
	}
}

func TestRustVisiblePublicItem(t *testing.T) {
	tier := &rustTier{}
	for _, vis := range []string{"public", "internal", ""} {
		cand := Candidate{
			Name: "Thing", Kind: "struct", Language: "rust",
			FilePath: "src/a.rs", Visibility: vis,
		}
		ref := &pendingRef{Reference: Reference{FromFileName: "src/b.rs", FromLanguage: "rust"}}
		if !tier.Visible(&cand, ref) {
			t.Errorf("visibility %q was scoped to its module; only `private` should be", vis)
		}
	}
}

func TestRustReceiverTypeSelf(t *testing.T) {
	tier := &rustTier{}
	src := `struct Server;

impl Server {
    fn run(&self) {
        self.stop();
    }
}

impl Clone for Server {
    fn clone(&self) -> Self {
        self.other()
    }
}
`
	file := &sourceFile{path: "s.rs", text: src, read: true}

	if got := tier.ReceiverType(&pendingRef{Reference: Reference{
		Name: "self.stop", FromLanguage: "rust", Line: 5,
	}}, file); got != "Server" {
		t.Errorf("self.stop → %q, want Server", got)
	}
	if got := tier.ReceiverType(&pendingRef{Reference: Reference{
		Name: "self.other", FromLanguage: "rust", Line: 12,
	}}, file); got != "Server" {
		t.Errorf("self.other in `impl Clone for Server` → %q, want Server", got)
	}
}

func TestRustBuiltins(t *testing.T) {
	tier := &rustTier{}
	for _, name := range []string{"Ok", "Err", "Some", "None", "Result", "Option", "Vec"} {
		if !tier.IsBuiltin(name) {
			t.Errorf("%q not recognised as a Rust prelude name", name)
		}
	}
	for _, name := range []string{"Server", "spawn", "Config"} {
		if tier.IsBuiltin(name) {
			t.Errorf("%q wrongly classified as a Rust prelude name", name)
		}
	}
}

// ----------------------------------------------------------------- Java ----

func TestJavaVisible(t *testing.T) {
	tier := &javaTier{}

	// Two files in one package, and one in another package. The package declaration is
	// read from the file, so the temp files carry it.
	mk := func(path, pkg string) string {
		writeTempSource(t, path, "package "+pkg+";\nclass X {}\n")
		return path
	}
	a := mk("a/PkgA.java", "com.example.a")
	b := mk("a/PkgB.java", "com.example.a")
	c := mk("b/Other.java", "com.example.b")

	samePkg := Candidate{Name: "Thing", Kind: "class", Language: "java", FilePath: a}
	refSame := &pendingRef{Reference: Reference{FromFileName: b, FromLanguage: "java"}}
	if !tier.Visible(&samePkg, refSame) {
		t.Error("a same-package type should be visible")
	}

	refOther := &pendingRef{Reference: Reference{FromFileName: c, FromLanguage: "java"}}
	if tier.Visible(&samePkg, refOther) {
		t.Error("a type in another package should not be visible without an import")
	}

	// `private` is file-scoped regardless of package.
	priv := Candidate{Name: "Thing", Kind: "class", Language: "java", FilePath: a, Visibility: "private"}
	if tier.Visible(&priv, refSame) {
		t.Error("a private type in another file should not be visible")
	}
}

// --------------------------------------------------------------- Kotlin ----

// TestKotlinVisiblePrivateIsFileScoped is the rule that differs from Java: Kotlin's
// `private` on a top-level declaration is file-private, and Kotlin files routinely hold
// several top-level declarations.
func TestKotlinVisiblePrivateIsFileScoped(t *testing.T) {
	tier := &kotlinTier{}
	pkgA := writeTempSource(t, "k/One.kt", "package com.example\n\nclass One\n")
	pkgB := writeTempSource(t, "k/Two.kt", "package com.example\n\nclass Two\n")

	priv := Candidate{Name: "helper", Kind: "function", Language: "kotlin",
		FilePath: pkgA, Visibility: "private"}

	// Same file: visible.
	if !tier.Visible(&priv, &pendingRef{Reference: Reference{FromFileName: pkgA, FromLanguage: "kotlin"}}) {
		t.Error("a file-private declaration should be visible in its own file")
	}
	// Same package, different file: NOT visible.
	if tier.Visible(&priv, &pendingRef{Reference: Reference{FromFileName: pkgB, FromLanguage: "kotlin"}}) {
		t.Error("Kotlin `private` is file-scoped, so another file must not see it")
	}

	// A public declaration in the same package is visible.
	pub := Candidate{Name: "One", Kind: "class", Language: "kotlin", FilePath: pkgA}
	if !tier.Visible(&pub, &pendingRef{Reference: Reference{FromFileName: pkgB, FromLanguage: "kotlin"}}) {
		t.Error("a public declaration in the same package should be visible")
	}
}

func TestKotlinBuiltins(t *testing.T) {
	tier := &kotlinTier{}
	for _, name := range []string{"println", "require", "listOf", "String", "Int", "Pair"} {
		if !tier.IsBuiltin(name) {
			t.Errorf("%q not recognised as a Kotlin default import", name)
		}
	}
	for _, name := range []string{"MyService", "handleRequest"} {
		if tier.IsBuiltin(name) {
			t.Errorf("%q wrongly classified as a Kotlin default import", name)
		}
	}
}

// ------------------------------------------------------------------- JS ----

// TestJSSealedModule is the rule behind the reference implementation's recorded failure:
// a module with an import and no export exports nothing, so nothing outside can name its
// bindings.
func TestJSSealedModule(t *testing.T) {
	sealed := writeTempSource(t, "js/sealed.ts",
		"import { createServer } from 'vite';\nconst vite = createServer();\n")
	if !jsModuleIsSealed(sealed) {
		t.Error("a module with an import and no export should be sealed")
	}

	open := writeTempSource(t, "js/open.ts",
		"import { x } from 'y';\nexport const thing = x;\n")
	if jsModuleIsSealed(open) {
		t.Error("a module with an export should not be sealed")
	}

	// A classic script has no import and no export: its declarations are globals.
	script := writeTempSource(t, "js/script.js", "var globalThing = 1;\n")
	if jsModuleIsSealed(script) {
		t.Error("a classic script should not be sealed")
	}

	// CommonJS exports keep a module open.
	cjs := writeTempSource(t, "js/cjs.js", "const a = require('a');\nmodule.exports = { a };\n")
	if jsModuleIsSealed(cjs) {
		t.Error("a CommonJS module should not be sealed")
	}

	// An ambient declaration keeps a module open.
	ambient := writeTempSource(t, "js/ambient.ts",
		"import { a } from 'b';\ndeclare global { interface Window { x: number } }\n")
	if jsModuleIsSealed(ambient) {
		t.Error("a module declaring a global should not be sealed")
	}
}

func TestJSVisibleAppliesSealedRule(t *testing.T) {
	tier := &jsTier{language: "typescript"}
	sealedFile := writeTempSource(t, "js/s.ts", "import { a } from 'b';\nconst helper = a;\n")
	otherFile := writeTempSource(t, "js/o.ts", "export const x = 1;\n")

	cand := Candidate{Name: "helper", Kind: "variable", Language: "typescript", FilePath: sealedFile}
	if tier.Visible(&cand, &pendingRef{Reference: Reference{FromFileName: otherFile, FromLanguage: "typescript"}}) {
		t.Error("a binding in a sealed module must not be visible from another file")
	}
	if !tier.Visible(&cand, &pendingRef{Reference: Reference{FromFileName: sealedFile, FromLanguage: "typescript"}}) {
		t.Error("a binding is always visible in its own file")
	}
}

func TestJSResolveSpecifier(t *testing.T) {
	tier := &jsTier{language: "typescript", aliases: map[string]string{"@/": "src/"}}

	cases := []struct {
		spec, from, want string
	}{
		{"./foo", "src/a/b.ts", "src/a/foo"},
		{"../lib/bar", "src/a/b.ts", "src/lib/bar"},
		{"@/components/Btn", "src/a/b.ts", "src/components/Btn"},
		{"react", "src/a/b.ts", ""},
		{"lodash/fp", "src/a/b.ts", ""},
	}
	for _, c := range cases {
		if got := tier.resolveSpecifier(c.spec, c.from); got != c.want {
			t.Errorf("resolveSpecifier(%q, %q) = %q, want %q", c.spec, c.from, got, c.want)
		}
	}
}

// TestParseTsconfigPaths covers the alias table's shape, including the comment tolerance
// real tsconfig files need.
func TestParseTsconfigPaths(t *testing.T) {
	body := `{
  // the build's own config
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@components/*": ["src/components/*"],
      "~lib": ["src/lib"],
    }
  }
}`
	aliases := parseTsconfigPaths(body)
	if aliases == nil {
		t.Fatal("no aliases parsed")
	}
	if aliases["@/"] != "src/" {
		t.Errorf(`aliases["@/"] = %q, want "src/"`, aliases["@/"])
	}
	if aliases["@components/"] != "src/components/" {
		t.Errorf(`aliases["@components/"] = %q`, aliases["@components/"])
	}
	// A target with no wildcard is a fixed path.
	if aliases["~lib"] != "src/lib" {
		t.Errorf(`aliases["~lib"] = %q, want "src/lib"`, aliases["~lib"])
	}
}

func TestStripJSONComments(t *testing.T) {
	in := `{"a": "http://x//y", // trailing
"b": /* block */ 1}`
	out := stripJSONComments(in)
	// The string containing `//` must survive intact.
	if !containsSubstring(out, "http://x//y") {
		t.Errorf("string literal was mangled: %q", out)
	}
	if containsSubstring(out, "trailing") || containsSubstring(out, "block") {
		t.Errorf("comments survived: %q", out)
	}
}

func containsSubstring(haystack, needle string) bool {
	return len(needle) == 0 || len(haystack) >= len(needle) &&
		func() bool {
			for i := 0; i+len(needle) <= len(haystack); i++ {
				if haystack[i:i+len(needle)] == needle {
					return true
				}
			}
			return false
		}()
}
