package builtin

// This file is a measurement harness, not a test.
//
// It lives under `go test` because that is the only runner that works in this
// sandbox (the built binary of a `go run` main package cannot be exec'd here), and
// it is skipped unless SCAN_OUT points somewhere. It exists so the shipped Go
// heuristic and the Python replay in scripts/outline_eval.py can be compared on
// the same files: if the two disagree, the evaluation's numbers describe a
// renderer the product does not actually have.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

type scanRow struct {
	Path    string `json:"path"`
	Lines   int    `json:"lines"`
	Entries int    `json:"entries"`
	Bytes   int    `json:"bytes"`
}

func TestScanOutlineFacts(t *testing.T) {
	out := os.Getenv("SCAN_OUT")
	if out == "" {
		t.Skip("measurement harness; set SCAN_OUT to run")
	}
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// out is relative to the package dir, where `go test` runs.
	root = filepath.Clean(filepath.Join(root, "..", "..", ".."))

	exts := map[string]bool{
		".go": true, ".ts": true, ".tsx": true, ".rs": true, ".py": true,
		".js": true, ".mjs": true, ".md": true, ".css": true,
	}
	skipDirs := map[string]bool{
		"node_modules": true, ".git": true, "dist": true, "target": true,
		".tmp-gocache": true, ".workbuddy": true, ".tudouni": true,
	}

	var rows []scanRow
	var totalFile, totalOutline int
	start := time.Now()

	err = filepath.Walk(root, func(p string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if info.IsDir() {
			if skipDirs[info.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !exts[strings.ToLower(filepath.Ext(p))] || info.Size() > 3_000_000 {
			return nil
		}
		raw, readErr := os.ReadFile(p)
		if readErr != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		rendered, lines, _ := RenderOutline(rel, string(raw))
		entries, _ := BuildOutline(rel, string(raw))
		rows = append(rows, scanRow{rel, lines, len(entries), len(rendered)})
		totalFile += len(raw)
		totalOutline += len(rendered)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	elapsed := time.Since(start)

	sort.Slice(rows, func(i, j int) bool { return rows[i].Bytes > rows[j].Bytes })
	payload := map[string]any{
		"root":          root,
		"files":         len(rows),
		"total_bytes":   totalFile,
		"outline_bytes": totalOutline,
		"elapsed_ms":    elapsed.Milliseconds(),
		"rows":          rows,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(out, encoded, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("scanned %d files, %.1f%% of bytes, %v", len(rows),
		100*float64(totalOutline)/float64(totalFile), elapsed)
}
