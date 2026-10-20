package cggraph

// Test helpers shared by the tier tests.
//
// `writeTempSource` exists because several tiers read the file's own text — Java's package
// declaration, Kotlin's package, JS's sealed-module check — so a tier test needs a real
// file on disk rather than an in-memory string. It returns the absolute path so a
// visibility comparison sees what production sees.

import (
	"os"
	"path/filepath"
	"testing"
)

// writeTempSource writes `body` to `rel` under a fresh temp directory and returns the
// absolute path.
//
// The path is cleaned to native separators, matching what the indexer produces.
func writeTempSource(t *testing.T, rel, body string) string {
	t.Helper()
	return writeTempSourceAt(t, t.TempDir(), rel, body)
}

// writeTempSourceAt writes `body` to `rel` under `dir` and returns the absolute path.
//
// Separate from writeTempSource because some rules relate two files — `#include "dict.c"`
// only resolves when both live in the same directory — and those need a shared root.
func writeTempSourceAt(t *testing.T, dir, rel, body string) string {
	t.Helper()
	path := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir for %s: %v", rel, err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
	return path
}
