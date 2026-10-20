package cgparse

import "encoding/binary"

// Row views.
//
// Each iterator hands back a fixed-size window into the buffer, not a decoded
// struct. That shape is deliberate: the resolver reads a handful of fields per
// row and the index writer wants the row verbatim, so materializing an
// everything-decoded struct per node would cost memory for fields most callers
// never touch. Accessors below resolve the fields that need the arena.

// NodeRow is one 96-byte node row.
type NodeRow struct{ b []byte }

// Kind is the wire code into NodeKindNames.
func (r NodeRow) Kind() uint8 { return r.b[0] }

// KindName is Kind() resolved, or "" when the code is out of range.
func (r NodeRow) KindName() string { return NodeKindName(r.b[0]) }

// Visibility is 0 absent / 1 public / 2 private / 3 protected / 4 internal.
func (r NodeRow) Visibility() uint8 { return r.b[1] }

// VisibilityName spells Visibility(), or "" when absent.
func (r NodeRow) VisibilityName() string {
	switch r.b[1] {
	case 1:
		return "public"
	case 2:
		return "private"
	case 3:
		return "protected"
	case 4:
		return "internal"
	}
	return ""
}

// Flags is the raw BoolFlags word.
func (r NodeRow) Flags() uint16 { return binary.LittleEndian.Uint16(r.b[2:]) }

// BoolFlag decodes one (present, value) bit pair. `pair` is 0 isExported,
// 1 isAsync, 2 isStatic, 3 isAbstract.
//
// The tri-state matters: `nil` means the extractor did not report the flag, and
// `false` means it reported false. Collapsing them would make "this Go method's
// export status is unknown" indistinguishable from "it is unexported", and Go
// resolution depends on that difference 鈥?the kernel does not set isExported for
// methods at all.
func (r NodeRow) BoolFlag(pair uint16) *bool {
	flags := r.Flags()
	if flags&(1<<(pair*2)) == 0 {
		return nil
	}
	value := flags&(1<<(pair*2+1)) != 0
	return &value
}

// IsExported reports the exported flag, nil when unreported.
func (r NodeRow) IsExported() *bool { return r.BoolFlag(0) }

// StartLine is 1-based.
func (r NodeRow) StartLine() uint32 { return binary.LittleEndian.Uint32(r.b[4:]) }

// EndLine is 1-based and inclusive.
func (r NodeRow) EndLine() uint32 { return binary.LittleEndian.Uint32(r.b[8:]) }

// StartColumn is 0-based.
func (r NodeRow) StartColumn() uint32 { return binary.LittleEndian.Uint32(r.b[12:]) }

// EndColumn is 0-based.
func (r NodeRow) EndColumn() uint32 { return binary.LittleEndian.Uint32(r.b[16:]) }

// Field offsets inside a node row, in the order buffers.rs walks them. Named so
// the accessors below and any future field cannot drift apart.
const (
	nodeNameAt          = 20
	nodeQualifiedNameAt = 28
	nodeIDAt            = 36
	nodeDocstringAt     = 44
	nodeSignatureAt     = 52
	nodeDecoratorsAt    = 60
	nodeTypeParamsAt    = 68
	nodeReturnTypeAt    = 76
	nodeExtraJSONAt     = 84
)

// Name is the simple symbol name.
func (r NodeRow) Name(f *File) string { s, _ := f.StrAt(r.b, nodeNameAt); return s }

// QualifiedName is the fully qualified name, "" when absent.
func (r NodeRow) QualifiedName(f *File) string { s, _ := f.StrAt(r.b, nodeQualifiedNameAt); return s }

// ID is the kernel-computed identifier: "kind:hash32", or "file:<path>" for a
// file node. Edges reference nodes by this string.
func (r NodeRow) ID(f *File) string { s, _ := f.StrAt(r.b, nodeIDAt); return s }

// Signature is the declared signature, "" when absent.
func (r NodeRow) Signature(f *File) string { s, _ := f.StrAt(r.b, nodeSignatureAt); return s }

// Docstring is the doc comment, "" when absent.
func (r NodeRow) Docstring(f *File) string { s, _ := f.StrAt(r.b, nodeDocstringAt); return s }

// ReturnType is the normalized return type, "" when absent.
func (r NodeRow) ReturnType(f *File) string { s, _ := f.StrAt(r.b, nodeReturnTypeAt); return s }

// Decorators is the decorator list, nil when absent.
func (r NodeRow) Decorators(f *File) []string { return f.StrList(r.b, nodeDecoratorsAt) }

// TypeParameters is the generic parameter list, nil when absent.
func (r NodeRow) TypeParameters(f *File) []string { return f.StrList(r.b, nodeTypeParamsAt) }

// ExtraJSON is the kernel's escape hatch for properties the fixed layout does not
// carry, "" when absent.
func (r NodeRow) ExtraJSON(f *File) string { s, _ := f.StrAt(r.b, nodeExtraJSONAt); return s }

// EdgeRow is one 44-byte edge row.
type EdgeRow struct{ b []byte }

// SourceIndex is the source node's row index, or None when the edge points
// outside this file's node set (then use SourceIDStr).
func (r EdgeRow) SourceIndex() uint32 { return binary.LittleEndian.Uint32(r.b[0:]) }

// TargetIndex is the target node's row index, or None.
func (r EdgeRow) TargetIndex() uint32 { return binary.LittleEndian.Uint32(r.b[4:]) }

// Kind is the wire code into EdgeKindNames.
func (r EdgeRow) Kind() uint8 { return r.b[8] }

// KindName is Kind() resolved.
func (r EdgeRow) KindName() string { return EdgeKindName(r.b[8]) }

// Provenance is 0 absent / 1 tree-sitter / 2 scip / 3 heuristic.
func (r EdgeRow) Provenance() uint8 { return r.b[9] }

// Line is the call site, or None.
func (r EdgeRow) Line() uint32 { return binary.LittleEndian.Uint32(r.b[12:]) }

// Column is the call site column, or None.
func (r EdgeRow) Column() uint32 { return binary.LittleEndian.Uint32(r.b[16:]) }

// MetadataJSON is extra edge metadata, "" when absent.
func (r EdgeRow) MetadataJSON(f *File) string { s, _ := f.StrAt(r.b, 20); return s }

// SourceIDStr is the source node id when SourceIndex is None.
func (r EdgeRow) SourceIDStr(f *File) string { s, _ := f.StrAt(r.b, 28); return s }

// TargetIDStr is the target node id when TargetIndex is None.
func (r EdgeRow) TargetIDStr(f *File) string { s, _ := f.StrAt(r.b, 36); return s }

// RefRow is one 40-byte unresolved-reference row.
type RefRow struct{ b []byte }

// FromIndex is the containing node's row index, or None.
func (r RefRow) FromIndex() uint32 { return binary.LittleEndian.Uint32(r.b[0:]) }

// Kind is the ReferenceKind: an EdgeKindNames index, or FunctionRefCode.
func (r RefRow) Kind() uint8 { return r.b[4] }

// KindName is Kind() resolved, which includes "function_ref".
func (r RefRow) KindName() string { return EdgeKindName(r.b[4]) }

// Flags carries REF_FLAG_FILE_PATH when the ref names the extracting file.
func (r RefRow) Flags() uint8 { return r.b[5] }

// CarriesFilePath reports the file-path flag.
func (r RefRow) CarriesFilePath() bool { return r.b[5]&RefFlagFilePath != 0 }

// Line is the reference's 1-based line.
func (r RefRow) Line() uint32 { return binary.LittleEndian.Uint32(r.b[8:]) }

// Column is the reference's 0-based column.
func (r RefRow) Column() uint32 { return binary.LittleEndian.Uint32(r.b[12:]) }

// ReferenceName is the name as written at the call site.
func (r RefRow) ReferenceName(f *File) string { s, _ := f.StrAt(r.b, 16); return s }

// Candidates is the NUL-joined candidate list the extractor pre-computed, nil when
// absent. The resolver may use it as a hint but must not treat it as exhaustive.
func (r RefRow) Candidates(f *File) []string { return f.StrList(r.b, 24) }

// FromIDStr is the containing node's id when FromIndex is None.
func (r RefRow) FromIDStr(f *File) string { s, _ := f.StrAt(r.b, 32); return s }

// Nodes iterates the node rows in wire order (which is also row-index order, so
// the iteration index is what an EdgeRow's SourceIndex/TargetIndex refers to).
func (f *File) Nodes(yield func(index int, row NodeRow) bool) {
	for i := 0; i < int(f.Meta.NodeCount); i++ {
		start := i * NodeRowSize
		if !yield(i, NodeRow{b: f.RawNodes[start : start+NodeRowSize]}) {
			return
		}
	}
}

// Edges iterates the edge rows.
func (f *File) Edges(yield func(index int, row EdgeRow) bool) {
	for i := 0; i < int(f.Meta.EdgeCount); i++ {
		start := i * EdgeRowSize
		if !yield(i, EdgeRow{b: f.RawEdges[start : start+EdgeRowSize]}) {
			return
		}
	}
}

// Refs iterates the unresolved-reference rows.
func (f *File) Refs(yield func(index int, row RefRow) bool) {
	for i := 0; i < int(f.Meta.RefCount); i++ {
		start := i * RefRowSize
		if !yield(i, RefRow{b: f.RawRefs[start : start+RefRowSize]}) {
			return
		}
	}
}

// NodeAt returns one node row by index.
func (f *File) NodeAt(index int) (NodeRow, bool) {
	if index < 0 || index >= int(f.Meta.NodeCount) {
		return NodeRow{}, false
	}
	start := index * NodeRowSize
	return NodeRow{b: f.RawNodes[start : start+NodeRowSize]}, true
}
