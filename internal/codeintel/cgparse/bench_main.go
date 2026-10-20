//go:build ignore

// Benchmark the full parse path against this repository's Go tree.
// Run: go run ./internal/cgparse/bench_test.go <repo root> <cg-parse binary>
package main

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel/cgparse"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Println("usage: bench <repo-root> <cg-parse-binary>")
		os.Exit(2)
	}
	root, binary := os.Args[1], os.Args[2]

	var refs []cgparse.Reference
	var sourceBytes int64
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			name := d.Name()
			if name == ".git" || name == "node_modules" || name == "dist" ||
				strings.HasPrefix(name, ".tmp") || name == ".workbuddy" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		sourceBytes += info.Size()
		refs = append(refs, cgparse.Reference{Path: path})
		return nil
	})
	if err != nil {
		fmt.Println("walk:", err)
		os.Exit(1)
	}

	fmt.Printf("files: %d   source: %.1f MB\n", len(refs), float64(sourceBytes)/(1<<20))

	for _, chunk := range []int{1, 8, 32, 128} {
		parser := &cgparse.Parser{Binary: binary, Concurrency: 4, ChunkSize: chunk}
		start := time.Now()
		results, err := parser.ParseAll(context.Background(), refs)
		elapsed := time.Since(start)
		if err != nil {
			fmt.Printf("chunk=%-4d FAILED: %v\n", chunk, err)
			continue
		}
		var nodes, edges, unresolved, failed int
		for _, r := range results {
			if !r.OK {
				failed++
				continue
			}
			n, e, rr := r.File.Counts()
			nodes += n
			edges += e
			unresolved += rr
		}
		fmt.Printf("chunk=%-4d %7.0f ms   nodes=%-7d edges=%-7d refs=%-7d failed=%d\n",
			chunk, float64(elapsed.Microseconds())/1000.0, nodes, edges, unresolved, failed)
	}
}
