package cgparse

import (
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// The decoder's whole job is agreeing with buffers.rs about byte offsets. These
// tests build buffers by hand from the documented layout — not from the encoder
// in this package, which would only prove it agrees with itself — and then assert
// that the accessors read the fields the layout says are there.

// buildFixture assembles one file's five buffers with known contents.
//
// Layout per buffers.rs:
//
//	node 96: kind@0 vis@1 flags@2(u16) startLine@4 endLine@8 startCol@12
//	         endCol@16 name@20 qname@28 id@36 doc@44 sig@52 decorators@60
//	         typeParams@68 returnType@76 extraJson@84 metrics@92
//	edge 44: srcIdx@0 tgtIdx@4 kind@8 prov@9 pad@10 line@12 col@16
//	         metadata@20 srcId@28 tgtId@36
//	ref  40: fromIdx@0 kind@4 flags@5 pad@6 line@8 col@12 name@16
//	         candidates@24 fromId@32
type fixture struct {
	meta, nodes, edges, refs, arena []byte
}

func putStr(arena *[]byte, s string) (uint32, uint32) {
	off := uint32(len(*arena))
	*arena = append(*arena, s...)
	return off, uint32(len(s))
}

func putStrRef(buf []byte, at int, off, length uint32) {
	binary.LittleEndian.PutUint32(buf[at:], off)
	binary.LittleEndian.PutUint32(buf[at+4:], length)
}

func buildFixture(t *testing.T) fixture {
	t.Helper()

	var arena []byte

	// Strings for the single node.
	nameOff, nameLen := putStr(&arena, "Run")
	qnOff, qnLen := putStr(&arena, "example::Server.Run")
	idOff, idLen := putStr(&arena, "method:abc123")
	sigOff, sigLen := putStr(&arena, "func (s *Server) Run(ctx context.Context) error")
	rtOff, rtLen := putStr(&arena, "error")
	decOff, decLen := putStr(&arena, "Override\x00Deprecated")

	node := make([]byte, NodeRowSize)
	node[0] = 8 // "method"
	node[1] = 1 // public
	// BoolFlags: pair 0 (isExported) present+true, pair 2 (isStatic) present+false.
	var flags uint16
	flags |= 1 << 0 // present
	flags |= 1 << 1 // value true
	flags |= 1 << 4 // present (isStatic, pair 2)
	binary.LittleEndian.PutUint16(node[2:], flags)
	binary.LittleEndian.PutUint32(node[4:], 40)  // startLine
	binary.LittleEndian.PutUint32(node[8:], 55)  // endLine
	binary.LittleEndian.PutUint32(node[12:], 4)  // startColumn
	binary.LittleEndian.PutUint32(node[16:], 20) // endColumn
	putStrRef(node, 20, nameOff, nameLen)
	putStrRef(node, 28, qnOff, qnLen)
	putStrRef(node, 36, idOff, idLen)
	putStrRef(node, 44, None, 0) // docstring absent
	putStrRef(node, 52, sigOff, sigLen)
	putStrRef(node, 60, decOff, decLen)
	putStrRef(node, 68, None, 0) // typeParameters absent
	putStrRef(node, 76, rtOff, rtLen)
	putStrRef(node, 84, None, 0) // extraJson absent

	// One edge: node 0 -> external id string (target index None).
	tgtIdOff, tgtIdLen := putStr(&arena, "function:def456")
	edge := make([]byte, EdgeRowSize)
	binary.LittleEndian.PutUint32(edge[0:], 0)    // source index 0
	binary.LittleEndian.PutUint32(edge[4:], None) // target index absent
	edge[8] = 1                                   // "calls"
	edge[9] = 1                                   // provenance tree-sitter
	binary.LittleEndian.PutUint32(edge[12:], 44)  // line
	binary.LittleEndian.PutUint32(edge[16:], 9)   // column
	putStrRef(edge, 20, None, 0)                  // no metadata
	putStrRef(edge, 28, None, 0)                  // no source id str
	putStrRef(edge, 36, tgtIdOff, tgtIdLen)

	// One ref: from node 0, a call named after an external thing.
	refNameOff, refNameLen := putStr(&arena, "logging.Info")
	candOff, candLen := putStr(&arena, "Info\x00Infof")
	ref := make([]byte, RefRowSize)
	binary.LittleEndian.PutUint32(ref[0:], 0)  // fromIndex
	ref[4] = 1                                 // kind "calls"
	ref[5] = 0                                 // flags
	binary.LittleEndian.PutUint32(ref[8:], 44) // line
	binary.LittleEndian.PutUint32(ref[12:], 9)
	putStrRef(ref, 16, refNameOff, refNameLen)
	putStrRef(ref, 24, candOff, candLen)
	putStrRef(ref, 32, None, 0)

	meta := make([]byte, MetaSize)
	meta[0] = ABIVersion
	binary.LittleEndian.PutUint32(meta[4:], 1)  // nodeCount
	binary.LittleEndian.PutUint32(meta[8:], 1)  // edgeCount
	binary.LittleEndian.PutUint32(meta[12:], 1) // refCount
	binary.LittleEndian.PutUint32(meta[16:], uint32(len(arena)))
	binary.LittleEndian.PutUint32(meta[20:], None) // no errors blob
	binary.LittleEndian.PutUint32(meta[24:], 0)
	binary.LittleEndian.PutUint64(meta[28:], math.Float64bits(3.5))

	return fixture{meta: meta, nodes: node, edges: edge, refs: ref, arena: arena}
}

func decodeFixture(t *testing.T, f fixture) *File {
	t.Helper()
	file, err := Decode("example.go", "go", f.meta, f.nodes, f.edges, f.refs, f.arena)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	return file
}

func TestDecodeRejectsWrongRowCounts(t *testing.T) {
	f := buildFixture(t)
	// A node buffer one row short of what meta claims is the layout-mismatch
	// case: decoding anyway would read plausible garbage for the last row.
	short := f.nodes[:NodeRowSize-1]
	if _, err := Decode("x.go", "go", f.meta, short, f.edges, f.refs, f.arena); err == nil {
		t.Fatal("Decode accepted a node buffer that does not match node_count")
	}
}

func TestDecodeRejectsUnknownABI(t *testing.T) {
	f := buildFixture(t)
	f.meta[0] = ABIVersion + 1
	if _, err := Decode("x.go", "go", f.meta, f.nodes, f.edges, f.refs, f.arena); err == nil {
		t.Fatal("Decode accepted an ABI version it does not know")
	}
}

func TestDecodeRejectsShortMeta(t *testing.T) {
	f := buildFixture(t)
	if _, err := Decode("x.go", "go", f.meta[:10], f.nodes, f.edges, f.refs, f.arena); err == nil {
		t.Fatal("Decode accepted a truncated meta buffer")
	}
}

func TestNodeRowFields(t *testing.T) {
	file := decodeFixture(t, buildFixture(t))

	var seen int
	file.Nodes(func(index int, row NodeRow) bool {
		seen++
		if index != 0 {
			t.Errorf("index = %d, want 0", index)
		}
		if got, want := row.Kind(), uint8(8); got != want {
			t.Errorf("kind = %d, want %d", got, want)
		}
		if got, want := row.KindName(), "method"; got != want {
			t.Errorf("kind name = %q, want %q", got, want)
		}
		if got, want := row.VisibilityName(), "public"; got != want {
			t.Errorf("visibility = %q, want %q", got, want)
		}
		if got, want := row.StartLine(), uint32(40); got != want {
			t.Errorf("start line = %d, want %d", got, want)
		}
		if got, want := row.EndLine(), uint32(55); got != want {
			t.Errorf("end line = %d, want %d", got, want)
		}
		if got, want := row.Name(file), "Run"; got != want {
			t.Errorf("name = %q, want %q", got, want)
		}
		if got, want := row.QualifiedName(file), "example::Server.Run"; got != want {
			t.Errorf("qualified name = %q, want %q", got, want)
		}
		if got, want := row.ID(file), "method:abc123"; got != want {
			t.Errorf("id = %q, want %q", got, want)
		}
		if got, want := row.Signature(file), "func (s *Server) Run(ctx context.Context) error"; got != want {
			t.Errorf("signature = %q, want %q", got, want)
		}
		if got, want := row.ReturnType(file), "error"; got != want {
			t.Errorf("return type = %q, want %q", got, want)
		}
		// An absent field must read as empty, not as an error or as junk.
		if got := row.Docstring(file); got != "" {
			t.Errorf("docstring = %q, want empty (absent)", got)
		}
		if got := row.ExtraJSON(file); got != "" {
			t.Errorf("extra JSON = %q, want empty (absent)", got)
		}
		got := row.Decorators(file)
		want := []string{"Override", "Deprecated"}
		if len(got) != len(want) {
			t.Fatalf("decorators = %v, want %v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("decorator[%d] = %q, want %q", i, got[i], want[i])
			}
		}
		if got := row.TypeParameters(file); got != nil {
			t.Errorf("type parameters = %v, want nil (absent)", got)
		}
		return true
	})
	if seen != 1 {
		t.Fatalf("iterated %d nodes, want 1", seen)
	}
}

// TestTriStateFlags is the one that matters for Go resolution: the kernel does not
// set isExported for methods, so `nil` (unreported) has to stay distinguishable
// from `false` (reported unexported).
func TestTriStateFlags(t *testing.T) {
	file := decodeFixture(t, buildFixture(t))
	file.Nodes(func(_ int, row NodeRow) bool {
		exported := row.IsExported()
		if exported == nil {
			t.Error("isExported = nil, want reported true")
		} else if !*exported {
			t.Error("isExported = false, want true")
		}

		static := row.BoolFlag(2)
		if static == nil {
			t.Error("isStatic = nil, want reported false")
		} else if *static {
			t.Error("isStatic = true, want false")
		}

		// Pair 1 (isAsync) was never written: must be nil, not false.
		if async := row.BoolFlag(1); async != nil {
			t.Errorf("isAsync = %v, want nil (unreported)", *async)
		}
		return true
	})
}

func TestEdgeRowFields(t *testing.T) {
	file := decodeFixture(t, buildFixture(t))

	var seen int
	file.Edges(func(_ int, row EdgeRow) bool {
		seen++
		if got, want := row.SourceIndex(), uint32(0); got != want {
			t.Errorf("source index = %d, want %d", got, want)
		}
		if got := row.TargetIndex(); got != None {
			t.Errorf("target index = %d, want None", got)
		}
		if got, want := row.KindName(), "calls"; got != want {
			t.Errorf("kind = %q, want %q", got, want)
		}
		if got := row.Line(); got != 44 {
			t.Errorf("line = %d, want 44", got)
		}
		// Target index is None, so the id string is the only way to name it.
		if got, want := row.TargetIDStr(file), "function:def456"; got != want {
			t.Errorf("target id = %q, want %q", got, want)
		}
		if got := row.SourceIDStr(file); got != "" {
			t.Errorf("source id str = %q, want empty", got)
		}
		return true
	})
	if seen != 1 {
		t.Fatalf("iterated %d edges, want 1", seen)
	}
}

func TestRefRowFields(t *testing.T) {
	file := decodeFixture(t, buildFixture(t))

	var seen int
	file.Refs(func(_ int, row RefRow) bool {
		seen++
		if got, want := row.FromIndex(), uint32(0); got != want {
			t.Errorf("from index = %d, want %d", got, want)
		}
		if got, want := row.ReferenceName(file), "logging.Info"; got != want {
			t.Errorf("reference name = %q, want %q", got, want)
		}
		if got, want := row.KindName(), "calls"; got != want {
			t.Errorf("kind = %q, want %q", got, want)
		}
		candidates := row.Candidates(file)
		if len(candidates) != 2 || candidates[0] != "Info" || candidates[1] != "Infof" {
			t.Errorf("candidates = %v, want [Info Infof]", candidates)
		}
		return true
	})
	if seen != 1 {
		t.Fatalf("iterated %d refs, want 1", seen)
	}
}

func TestFunctionRefCodeIsNotAnEdgeKind(t *testing.T) {
	// 200 is the internal-only code; naming it "references" or indexing into
	// EdgeKindNames at 200 would be out of range and silently wrong.
	if got, want := EdgeKindName(FunctionRefCode), "function_ref"; got != want {
		t.Errorf("EdgeKindName(%d) = %q, want %q", FunctionRefCode, got, want)
	}
	if got := EdgeKindName(255); got != "" {
		t.Errorf("EdgeKindName(255) = %q, want empty", got)
	}
}

func TestStrDistinguishesAbsentFromEmpty(t *testing.T) {
	file := decodeFixture(t, buildFixture(t))
	if _, ok := file.Str(None, 0); ok {
		t.Error("Str(None) reported present")
	}
	// An empty string that IS present: offset 0, length 0, arena non-empty.
	if _, ok := file.Str(0, 0); !ok {
		t.Error("Str(0,0) reported absent, want present-but-empty")
	}
}

// TestAgainstRealBinary exercises the decoder against cg-parse itself when it is
// available, which is the only check that catches a disagreement with the actual
// kernel rather than with this package's reading of the layout.
//
// Skipped when the binary is not on disk: the package's own tests must pass on a
// machine that has never built the Rust side.
func TestAgainstRealBinary(t *testing.T) {
	binary := os.Getenv("CG_PARSE_BIN")
	if binary == "" {
		// Default to the build directory used during development.
		for _, candidate := range defaultBinaryPaths() {
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				binary = candidate
				break
			}
		}
	}
	if binary == "" {
		t.Skip("cg-parse not found; set CG_PARSE_BIN to run this test")
	}

	// A Go file with known structure: one function, one import.
	dir := t.TempDir()
	src := filepath.Join(dir, "sample.go")
	code := `package sample

import "context"

// Run does the thing.
func Run(ctx context.Context) error {
	return nil
}

func helper() {}
`
	if err := os.WriteFile(src, []byte(code), 0o644); err != nil {
		t.Fatalf("write sample: %v", err)
	}

	parser := &Parser{Binary: binary, Concurrency: 1, ChunkSize: 1}
	results, err := parser.ParseAll(t.Context(), []Reference{{Path: src, Language: "go"}})
	if err != nil {
		t.Fatalf("ParseAll: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("got %d results, want 1", len(results))
	}
	result := results[0]
	if !result.OK {
		t.Fatalf("parse failed: %s", result.Error)
	}

	names := map[string]bool{}
	result.File.Nodes(func(_ int, row NodeRow) bool {
		names[row.Name(result.File)] = true
		return true
	})
	for _, want := range []string{"Run", "helper"} {
		if !names[want] {
			t.Errorf("node %q missing; got %v", want, keysOf(names))
		}
	}

	// The reference to context.Context must arrive as an unresolved ref: that is
	// exactly the input the Go resolver consumes.
	refNames := map[string]bool{}
	result.File.Refs(func(_ int, row RefRow) bool {
		refNames[row.ReferenceName(result.File)] = true
		return true
	})
	if len(refNames) == 0 {
		t.Error("no unresolved refs decoded; a file with an import and a call has some")
	}
}

func keysOf(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func defaultBinaryPaths() []string {
	paths := []string{
		filepath.Join("..", "..", "tools", "vendor", "cg", "cg-parse.exe"),
		filepath.Join("..", "..", "tools", "vendor", "cg", "cg-parse"),
	}
	if runtime.GOOS == "windows" {
		paths = append(paths, `C:\cg-target\release\cg-parse.exe`)
	}
	return paths
}
