package cgwasm

// Parsing and tree traversal through the ts_* API.
//
// The marshalling pattern is the whole interface, and it is worth stating once:
//
//   - a node is five i32 words: id, startByte, startRow, startColumn, other
//   - a function that RETURNS a node takes its destination implicitly and writes to
//     `h.transfer`; so every node operation is "marshal the input node to transfer, call,
//     read the result from transfer"
//   - a function that TAKES a node is passed the address of a marshalled node, which is
//     always `h.transfer` in practice
//
// Because transfer is a single shared slot, a traversal cannot hold two nodes at once.
// Children are therefore read by value immediately and re-marshalled when visited, which
// costs four word writes per step and avoids a per-node allocation scheme.

import (
	"context"
	"fmt"
)

// Tree is one parsed file.
type Tree struct {
	host *Host
	addr uint32
}

// Parse parses `source` and returns the tree.
//
// The tree owns WASM-side memory and must be freed with Close; a caller that parses many
// files should close each tree before the next parse, because the parser keeps one transfer
// buffer and the allocator is shared.
func (h *Host) Parse(source []byte) (*Tree, error) {
	if err := h.writeSource(source); err != nil {
		return nil, err
	}
	parse := h.parserMod.ExportedFunction("ts_parser_parse_wasm")
	if parse == nil {
		return nil, fmt.Errorf("cgwasm: parser exports no ts_parser_parse_wasm")
	}
	// (parser, options, oldTree, includedRanges, includedRangeCount)
	//
	// `options` is the second argument the JS binding passes as `this[1]`, which it leaves
	// at zero for a string parse; `oldTree` is zero because nothing here is incremental; and
	// the range list is empty because the whole file is parsed.
	out, err := parse.Call(h.ctx, uint64(h.parser), 0, 0, 0, 0)
	if err != nil {
		return nil, fmt.Errorf("cgwasm: ts_parser_parse_wasm: %w", err)
	}
	if len(out) != 1 || out[0] == 0 {
		return nil, fmt.Errorf("cgwasm: parse produced no tree")
	}
	return &Tree{host: h, addr: uint32(out[0])}, nil
}

// Close frees the tree.
func (t *Tree) Close() {
	if t == nil || t.addr == 0 {
		return
	}
	if fn := t.host.parserMod.ExportedFunction("ts_tree_delete"); fn != nil {
		_, _ = fn.Call(t.host.ctx, uint64(t.addr))
	}
	t.addr = 0
}

// Root returns the tree's root node.
func (t *Tree) Root() (Node, error) {
	fn := t.host.parserMod.ExportedFunction("ts_tree_root_node_wasm")
	if fn == nil {
		return Node{}, fmt.Errorf("cgwasm: parser exports no ts_tree_root_node_wasm")
	}
	if _, err := fn.Call(t.host.ctx, uint64(t.addr)); err != nil {
		return Node{}, fmt.Errorf("cgwasm: ts_tree_root_node_wasm: %w", err)
	}
	return t.host.unmarshalNode()
}

// unmarshalNode reads a node from the transfer buffer.
func (h *Host) unmarshalNode() (Node, error) {
	words, err := h.readTransfer(nodeFields)
	if err != nil {
		return Node{}, err
	}
	node := Node{
		ID:        words[0],
		StartByte: words[1],
		StartRow:  words[2],
		StartCol:  words[3],
		Other:     words[4],
	}
	if node.ID == 0 {
		return Node{}, fmt.Errorf("cgwasm: null node")
	}
	node.Type = h.nodeType(node.ID)
	node.Named = h.nodeIsNamed(node.ID)
	return node, nil
}

// marshalNode writes a node into the transfer buffer.
func (h *Host) marshalNode(node Node) bool {
	words := [nodeFields]uint32{node.ID, node.StartByte, node.StartRow, node.StartCol, node.Other}
	for i, word := range words {
		if !h.writeU32(h.transfer+uint32(i*SizeOfInt), word) {
			return false
		}
	}
	return true
}

// readTransfer reads n words from the transfer buffer.
func (h *Host) readTransfer(n uint32) ([]uint32, error) {
	words := make([]uint32, n)
	for i := uint32(0); i < n; i++ {
		words[i] = h.readU32(h.transfer + i*SizeOfInt)
	}
	return words, nil
}

// nodeType resolves a node's type name through the language symbol table.
//
// The wasm build exposes no `ts_node_type`; the binding resolves the name from the symbol
// id instead, which is why this is two calls rather than one.
func (h *Host) nodeType(nodeID uint32) string {
	symbol := h.nodeSymbol(nodeID)
	if symbol == 0 {
		return ""
	}
	fn := h.parserMod.ExportedFunction("ts_language_symbol_name")
	if fn == nil {
		return ""
	}
	out, err := fn.Call(h.ctx, uint64(h.language), uint64(symbol))
	if err != nil || len(out) != 1 {
		return ""
	}
	return h.readCString(uint32(out[0]))
}

// nodeSymbol returns a node's type id in the grammar.
func (h *Host) nodeSymbol(nodeID uint32) uint32 {
	fn := h.parserMod.ExportedFunction("ts_node_symbol_wasm")
	if fn == nil {
		return 0
	}
	// The node must be marshalled first: `ts_node_symbol_wasm` takes a node pointer.
	if !h.writeU32(h.transfer, nodeID) {
		return 0
	}
	// A marshalled node needs all five words present, so the remaining four are left as the
	// caller wrote them — this is only ever called right after unmarshalNode.
	out, err := fn.Call(h.ctx, uint64(h.transfer))
	if err != nil || len(out) != 1 {
		return 0
	}
	return uint32(out[0])
}

// nodeIsNamed reports whether a node is a named node.
func (h *Host) nodeIsNamed(nodeID uint32) bool {
	fn := h.parserMod.ExportedFunction("ts_node_is_named_wasm")
	if fn == nil {
		// Without the call, treat every node as named: extraction then sees more nodes than
		// it should, which is preferable to seeing none.
		return true
	}
	if !h.writeU32(h.transfer, nodeID) {
		return true
	}
	out, err := fn.Call(h.ctx, uint64(h.transfer))
	if err != nil || len(out) != 1 {
		return true
	}
	return out[0] != 0
}

// ChildCount returns how many children a node has.
func (t *Tree) ChildCount(node Node) int {
	ctx := t.host.ctx
	for _, name := range []string{"ts_node_child_count_wasm", "ts_node_child_count"} {
		fn := t.host.parserMod.ExportedFunction(name)
		if fn == nil {
			continue
		}
		if !t.host.marshalNode(node) {
			return 0
		}
		out, err := fn.Call(ctx, uint64(t.host.transfer))
		if err != nil || len(out) != 1 {
			return 0
		}
		return int(uint32(out[0]))
	}
	return 0
}

// Children returns a node's children.
//
// The child index is a positional index over ALL children, anonymous ones included; callers
// that only want named nodes filter on `Named`.
func (t *Tree) Children(node Node) []Node {
	count := t.ChildCount(node)
	if count <= 0 {
		return nil
	}
	fn := t.host.parserMod.ExportedFunction("ts_node_child_wasm")
	if fn == nil {
		return nil
	}
	out := make([]Node, 0, count)
	for i := 0; i < count; i++ {
		if !t.host.marshalNode(node) {
			return out
		}
		results, err := fn.Call(t.host.ctx, uint64(t.host.transfer), uint64(i))
		if err != nil || len(results) != 0 {
			continue
		}
		child, err := t.host.unmarshalNode()
		if err != nil {
			continue
		}
		out = append(out, child)
	}
	return out
}

// FieldName returns the field name a child occupies in its parent, or "".
//
// Field names are what make extraction precise: a `declarator` field is a declarator
// wherever the grammar puts it, while a positional index is not.
func (t *Tree) FieldName(node Node, index int) string {
	fn := t.host.parserMod.ExportedFunction("ts_node_field_name_for_child_wasm")
	if fn == nil {
		return ""
	}
	if !t.host.marshalNode(node) {
		return ""
	}
	out, err := fn.Call(t.host.ctx, uint64(t.host.transfer), uint64(index))
	if err != nil || len(out) != 1 {
		return ""
	}
	return t.host.readCString(uint32(out[0]))
}

// EndPoint returns a node's end position.
func (t *Tree) EndPoint(node Node) (row, column uint32) {
	fn := t.host.parserMod.ExportedFunction("ts_node_end_point_wasm")
	if fn == nil {
		return node.StartRow, node.StartCol
	}
	if !t.host.marshalNode(node) {
		return node.StartRow, node.StartCol
	}
	if _, err := fn.Call(t.host.ctx, uint64(t.host.transfer)); err != nil {
		return node.StartRow, node.StartCol
	}
	words, err := t.host.readTransfer(2)
	if err != nil || len(words) < 2 {
		return node.StartRow, node.StartCol
	}
	return words[0], words[1]
}

// HasError reports whether the tree contains a syntax error node.
//
// This is what makes the fallback honest: recovery produces a usable tree for a file with
// errors, and a caller that needs to know whether the parse was clean can ask.
func (t *Tree) HasError() bool {
	root, err := t.Root()
	if err != nil {
		return true
	}
	return t.hasErrorNode(root, 0)
}

// hasErrorNode walks until it finds an `ERROR` node or an error-flagged node.
//
// Depth-bounded rather than exhaustive: a recovery tree can be enormous, and one error is
// enough to answer the question.
func (t *Tree) hasErrorNode(node Node, depth int) bool {
	if depth > 64 {
		return false
	}
	if node.Type == "ERROR" {
		return true
	}
	fn := t.host.parserMod.ExportedFunction("ts_node_is_error_wasm")
	if fn != nil {
		if t.host.marshalNode(node) {
			if out, err := fn.Call(t.host.ctx, uint64(t.host.transfer)); err == nil && len(out) == 1 && out[0] != 0 {
				return true
			}
		}
	}
	for _, child := range t.Children(node) {
		if t.hasErrorNode(child, depth+1) {
			return true
		}
	}
	return false
}

var _ = context.Background
