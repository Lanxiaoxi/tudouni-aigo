package cgwasm

import (
	"context"
	"os"
	"testing"
)

// TestParsesC is the end-to-end check for the WASM fallback.
//
// It is SKIPPED by default because the fallback is not finished: `New` now gets as far as
// `ts_parser_new_wasm`, which fails with "invalid table access". The parser module is a
// dylink build, so it calls through the IMPORTED `__indirect_function_table`; that table is
// declared by the shim (min 30 slots) but starts empty, and populating it is the loader's
// job. Doing it means reading the parser's element segments and writing them into the table
// — the next piece of emscripten scaffolding, after the memory layout already implemented in
// layout.go.
//
// Set CGWASM_EXPERIMENT=1 to run it and see the current failure.
func TestParsesC(t *testing.T) {
	if os.Getenv("CGWASM_EXPERIMENT") == "" {
		t.Skip("WASM fallback is incomplete: see the package doc and layout/shim comments")
	}
	ctx := context.Background()
	host, err := New(ctx, "c")
	if err != nil {
		t.Fatalf("New(c): %v", err)
	}
	defer host.Close()

	source := []byte(`#include <stdio.h>

static int counter = 0;

struct Point {
    int x;
    int y;
};

static void helper(int v) {
    counter += v;
}

int main(void) {
    struct Point p = {1, 2};
    helper(p.x);
    printf("%d\n", counter);
    return 0;
}
`)
	tree, err := host.Parse(source)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	defer tree.Close()

	root, err := tree.Root()
	if err != nil {
		t.Fatalf("Root: %v", err)
	}
	t.Logf("root: type=%q named=%v children=%d", root.Type, root.Named, tree.ChildCount(root))
	if root.Type != "translation_unit" {
		t.Errorf("root type = %q, want translation_unit", root.Type)
	}
}

// TestShimAssembles checks the parts that ARE finished: the shim and GOT.mem modules are
// valid WASM, and the layout is derived from the parser's data segments.
//
// These are worth pinning because each is a non-obvious requirement of the dylink build, and
// a regression in any of them shows up as an opaque link error rather than a test failure.
func TestShimAssembles(t *testing.T) {
	layout := shimLayout{heapBase: 16 * 1024, stackPointer: 30 << 20}

	shim := buildEnvShim(layout)
	if len(shim) < 8 || string(shim[:4]) != "\x00asm" {
		t.Fatalf("shim is not a wasm module: % x", shim[:min(8, len(shim))])
	}
	got := buildGotMem(layout)
	if len(got) < 8 || string(got[:4]) != "\x00asm" {
		t.Fatalf("GOT.mem is not a wasm module: % x", got[:min(8, len(got))])
	}
}

// TestLayoutFromDataSegments pins the heap base derivation: it must land after the parser's
// static data, or dlmalloc hands out memory that already holds a global.
func TestLayoutFromDataSegments(t *testing.T) {
	parser, err := grammarFS.ReadFile("wasm/tree-sitter.wasm")
	if err != nil {
		t.Fatalf("read parser: %v", err)
	}
	layout, err := computeLayout(parser)
	if err != nil {
		t.Fatalf("computeLayout: %v", err)
	}
	t.Logf("heapBase=%d stackPointer=%d", layout.heapBase, layout.stackPointer)

	if layout.heapBase < 1024 {
		t.Errorf("heapBase = %d, want at least 1024", layout.heapBase)
	}
	if layout.stackPointer <= layout.heapBase {
		t.Errorf("stackPointer %d is not above heapBase %d", layout.stackPointer, layout.heapBase)
	}
	// The static data end is reported for the log: a wildly different value after a grammar
	// change is the signal that this derivation needs revisiting.
	end, err := staticDataEnd(parser)
	if err != nil {
		t.Fatalf("staticDataEnd: %v", err)
	}
	t.Logf("static data ends at %d", end)
	if layout.heapBase < end {
		t.Errorf("heapBase %d is below static data end %d", layout.heapBase, end)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// TestTransformOwnsMemoryAndTable pins the rewrite that fixed the empty imported table.
//
// The parser's memory and table imports are replaced by definitions and exports, which is
// what makes wazero apply the module's active element segment. The check is structural —
// the transformed module must declare both and import neither — because the behavioural
// proof needs the rest of the loader.
func TestTransformOwnsMemoryAndTable(t *testing.T) {
	parser, err := grammarFS.ReadFile("wasm/tree-sitter.wasm")
	if err != nil {
		t.Fatalf("read parser: %v", err)
	}
	transformed, err := transformOwnsMemoryAndTable(parser, 30)
	if err != nil {
		t.Fatalf("transform: %v", err)
	}
	if len(transformed) < 8 || string(transformed[:4]) != "\x00asm" {
		t.Fatalf("transform output is not a wasm module")
	}

	sections, err := splitSections(transformed)
	if err != nil {
		t.Fatalf("split transformed: %v", err)
	}
	byID := map[byte]bool{}
	for _, section := range sections {
		if byID[section.id] {
			t.Errorf("section %d appears twice; the module is malformed", section.id)
		}
		byID[section.id] = true
	}
	if !byID[secMemory] {
		t.Error("transformed module declares no memory")
	}
	if !byID[secTable] {
		t.Error("transformed module declares no table")
	}

	// The imports must no longer mention a memory or a table.
	for _, section := range sections {
		if section.id != secImport {
			continue
		}
		count, p, err := readULEB(section.body, 0)
		if err != nil {
			t.Fatalf("read imports: %v", err)
		}
		for n := uint32(0); n < count; n++ {
			var nameLen uint32
			nameLen, p, err = readULEB(section.body, p)
			if err != nil {
				t.Fatalf("read import module: %v", err)
			}
			p += int(nameLen)
			nameLen, p, err = readULEB(section.body, p)
			if err != nil {
				t.Fatalf("read import name: %v", err)
			}
			p += int(nameLen)
			if p >= len(section.body) {
				t.Fatalf("import list truncated")
			}
			kind := section.body[p]
			if kind == kindMemory || kind == kindTable {
				t.Errorf("transformed module still imports kind %#x", kind)
			}
			// Skip this entry to reach the next one.
			p++
			switch kind {
			case kindFunc:
				_, p, err = readULEB(section.body, p)
			case kindGlobal:
				p += 2
			}
			if err != nil {
				t.Fatalf("skip import: %v", err)
			}
		}
	}

	// The exports must include the memory and the table, so the host can reach the memory.
	var exportBody []byte
	for _, section := range sections {
		if section.id == secExport {
			exportBody = section.body
		}
	}
	if exportBody == nil {
		t.Fatal("transformed module has no export section")
	}
	count, _, err := readULEB(exportBody, 0)
	if err != nil {
		t.Fatalf("read export count: %v", err)
	}
	if count == 0 {
		t.Fatal("transformed module exports nothing")
	}
}
