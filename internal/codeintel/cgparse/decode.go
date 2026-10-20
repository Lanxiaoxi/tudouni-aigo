// Package cgparse decodes the buffers `cg-parse` produces.
//
// The wire contract belongs to CodeGraph's Rust kernel and is reproduced here
// rather than invented: five flat tables per file, fixed-width little-endian
// rows, every string an (offset, length) pair into a shared UTF-8 arena. See
// `codegraph-kernel/src/buffers.rs` — the Rust source is the authority, and a
// layout change there bumps its KERNEL_ABI_VERSION, which `Decode` checks.
//
// Rows are deliberately not decoded into rich Go values here. Resolver work wants
// nodes, edges and refs as structs, but the index writer wants them streamed
// straight into SQLite, and a decoder that insists on materializing everything
// would force the caller to hold an entire file's graph before writing any of
// it. `Decode` therefore exposes the tables and the arena, plus iterators over
// rows; turning a row into a value is the caller's one-liner.
package cgparse

import (
	"encoding/binary"
	"fmt"
	"math"
)

// Row sizes and the sentinel value, mirroring buffers.rs. These are part of the
// contract, not tunables: a decode that used a different width would silently
// read every row after the first at the wrong offset.
const (
	MetaSize    = 36
	NodeRowSize = 96
	EdgeRowSize = 44
	RefRowSize  = 40

	// ABIVersion is the layout version this package understands.
	ABIVersion = 2

	// None marks an absent u32: no string (offset), no endpoint index, no
	// line/column. It is 0xFFFFFFFF, not 0, because 0 is a legitimate arena
	// offset and a legitimate row index.
	None uint32 = 0xFFFF_FFFF

	// FunctionRefCode is the internal-only ReferenceKind for "a function used as
	// a value" (a callback registration). It never becomes an edge kind; the
	// resolver maps it to a `references` edge.
	FunctionRefCode uint8 = 200

	// RefFlagFilePath means the ref carries the extracting file's path.
	RefFlagFilePath uint8 = 1
)

// NodeKindNames and EdgeKindNames are the wire order. A kind crosses the boundary
// as its index into these slices, so the order is part of the contract: append,
// never reorder.
var (
	NodeKindNames = []string{
		"file", "module", "class", "struct", "interface", "trait", "protocol",
		"function", "method", "property", "field", "variable", "constant", "enum",
		"enum_member", "type_alias", "namespace", "parameter", "import", "export",
		"route", "component", "union",
	}
	EdgeKindNames = []string{
		"contains", "calls", "imports", "exports", "extends", "implements",
		"references", "type_of", "returns", "instantiates", "overrides",
		"decorates", "navigates",
	}
)

// NodeKindName returns the name for a wire code, or "" when out of range.
func NodeKindName(code uint8) string {
	if int(code) < len(NodeKindNames) {
		return NodeKindNames[code]
	}
	return ""
}

// EdgeKindName returns the name for a wire code. FunctionRefCode has its own
// name because it is not an edge kind.
func EdgeKindName(code uint8) string {
	if code == FunctionRefCode {
		return "function_ref"
	}
	if int(code) < len(EdgeKindNames) {
		return EdgeKindNames[code]
	}
	return ""
}

// Meta is the decoded 36-byte header.
type Meta struct {
	ABI        uint8
	NodeCount  uint32
	EdgeCount  uint32
	RefCount   uint32
	ArenaBytes uint32
	// ErrorsOffset/ErrorsLength locate a JSON blob in the arena describing
	// per-file extraction errors. ErrorsOffset == None means there were none.
	ErrorsOffset uint32
	ErrorsLength uint32
	DurationMS   float64
}

// ABIWire is the layout version this package decodes.
func (m *Meta) ABIWire() uint8 { return m.ABI }

// File is one file's decoded tables.
//
// The Raw* slices are the encoded rows: iterate with `Nodes()`, `Edges()`,
// `Refs()`, which hand back fixed-size views. Keeping the buffers rather than
// pre-decoding means a caller that only wants nodes never pays for the refs,
// which on an import-heavy file are most of the payload.
type File struct {
	Path     string
	Lang     string
	Meta     Meta
	RawNodes []byte
	RawEdges []byte
	RawRefs  []byte
	Arena    []byte
}

// Decode splits one file's buffers and validates the metadata against them.
//
// A mismatch is an error rather than a best-effort guess: a row count that does
// not divide evenly into rows means the two sides disagree about the layout, and
// decoding anyway would return a graph that looks plausible and is wrong.
func Decode(path, lang string, meta, nodes, edges, refs, arena []byte) (*File, error) {
	if len(meta) != MetaSize {
		return nil, fmt.Errorf("cgparse: meta is %d bytes, want %d", len(meta), MetaSize)
	}
	m := Meta{
		ABI:          meta[0],
		NodeCount:    binary.LittleEndian.Uint32(meta[4:]),
		EdgeCount:    binary.LittleEndian.Uint32(meta[8:]),
		RefCount:     binary.LittleEndian.Uint32(meta[12:]),
		ArenaBytes:   binary.LittleEndian.Uint32(meta[16:]),
		ErrorsOffset: binary.LittleEndian.Uint32(meta[20:]),
		ErrorsLength: binary.LittleEndian.Uint32(meta[24:]),
		DurationMS:   math.Float64frombits(binary.LittleEndian.Uint64(meta[28:])),
	}
	if m.ABI != ABIVersion {
		return nil, fmt.Errorf("cgparse: ABI %d, this package decodes %d", m.ABI, ABIVersion)
	}
	if got := uint32(len(nodes)); got != m.NodeCount*NodeRowSize {
		return nil, fmt.Errorf("cgparse: nodes buffer is %d bytes, want %d rows × %d = %d",
			got, m.NodeCount, NodeRowSize, m.NodeCount*NodeRowSize)
	}
	if got := uint32(len(edges)); got != m.EdgeCount*EdgeRowSize {
		return nil, fmt.Errorf("cgparse: edges buffer is %d bytes, want %d rows × %d = %d",
			got, m.EdgeCount, EdgeRowSize, m.EdgeCount*EdgeRowSize)
	}
	if got := uint32(len(refs)); got != m.RefCount*RefRowSize {
		return nil, fmt.Errorf("cgparse: refs buffer is %d bytes, want %d rows × %d = %d",
			got, m.RefCount, RefRowSize, m.RefCount*RefRowSize)
	}
	if m.ArenaBytes != uint32(len(arena)) {
		return nil, fmt.Errorf("cgparse: arena is %d bytes, meta says %d", len(arena), m.ArenaBytes)
	}
	return &File{
		Path: path, Lang: lang, Meta: m,
		RawNodes: nodes, RawEdges: edges, RawRefs: refs, Arena: arena,
	}, nil
}

// Str resolves an (offset, length) pair against the arena.
//
// An absent field (offset None) returns ("", false) — distinct from a present but
// empty string, which returns ("", true). The kernel writes empty strings for
// genuinely-empty values, and callers that conflate the two end up treating
// "unknown" and "known to be empty" as the same thing.
func (f *File) Str(offset, length uint32) (string, bool) {
	if offset == None {
		return "", false
	}
	end := uint64(offset) + uint64(length)
	if end > uint64(len(f.Arena)) {
		return "", false
	}
	return string(f.Arena[offset:end]), true
}

// StrAt resolves the pair stored at byte offset `at` in row `b`.
func (f *File) StrAt(b []byte, at int) (string, bool) {
	return f.Str(binary.LittleEndian.Uint32(b[at:]), binary.LittleEndian.Uint32(b[at+4:]))
}

// StrList resolves a NUL-joined list field. Absent and empty both yield nil.
func (f *File) StrList(b []byte, at int) []string {
	raw, ok := f.StrAt(b, at)
	if !ok || raw == "" {
		return nil
	}
	parts := splitNUL(raw)
	if len(parts) == 1 && parts[0] == "" {
		return nil
	}
	return parts
}

func splitNUL(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == 0 {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}

// Errors returns the per-file extraction errors the kernel recorded, if any.
func (f *File) Errors() string {
	if f.Meta.ErrorsOffset == None {
		return ""
	}
	text, _ := f.Str(f.Meta.ErrorsOffset, f.Meta.ErrorsLength)
	return text
}

// Counts is a convenience for logging and tests.
func (f *File) Counts() (nodes, edges, refs int) {
	return int(f.Meta.NodeCount), int(f.Meta.EdgeCount), int(f.Meta.RefCount)
}
