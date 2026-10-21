package cggraph

import (
	"path/filepath"
	"testing"
)

// TestScanTreeOnlySkipsBuildNamesAtTheRoot: `release` and `build` are build-output
// names and ordinary package names. The old basename-only rule made this
// repository's own internal/release and tools/release invisible to every query.
func TestScanTreeOnlySkipsBuildNamesAtTheRoot(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{
		"internal/release/x.go", // source, must be indexed
		"tools/release/y.go",    // source, must be indexed
		"pkg/build/z.go",        // source in a monorepo package, must be indexed
		"release/bin.go",        // root build output, must be skipped
		"build/gen.go",          // root build output, must be skipped
		"dist/bundle.js",        // any-depth output, must be skipped
	} {
		writeTempSourceAt(t, root, rel, "package p\n")
	}

	files, err := scanTree(root)
	if err != nil {
		t.Fatalf("scanTree: %v", err)
	}
	seen := map[string]bool{}
	for _, file := range files {
		rel, err := filepath.Rel(root, file.path)
		if err != nil {
			t.Fatalf("relative path: %v", err)
		}
		seen[filepath.ToSlash(rel)] = true
	}

	for _, want := range []string{"internal/release/x.go", "tools/release/y.go", "pkg/build/z.go"} {
		if !seen[want] {
			t.Errorf("%s was skipped; it is source, not build output", want)
		}
	}
	for _, unwanted := range []string{"release/bin.go", "build/gen.go", "dist/bundle.js"} {
		if seen[unwanted] {
			t.Errorf("%s was indexed; it is build output", unwanted)
		}
	}
}
