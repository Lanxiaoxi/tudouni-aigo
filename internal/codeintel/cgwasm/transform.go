package cgwasm

// Rewriting the parser module so it owns its memory and function table.
//
// The problem this solves: tree-sitter.wasm IMPORTS `env.memory` and
// `env.__indirect_function_table`. A shim can supply both — it is a real wasm module, so it
// can define them — but wazero does not apply the parser's ACTIVE ELEMENT SEGMENT to a table
// it imported. The table is created empty, the element segment that should fill slots 0..29
// is dropped, and the first indirect call fails with "invalid table access". wazero v1.12
// exposes no Table API (`// TODO: Table` in api/wasm.go), so there is no way to fill it from
// Go either.
//
// The fix is to make the module self-contained for those two things: drop the two imports,
// declare the memory and table in the module's own sections, and export them so the host can
// still reach the memory. A defined table gets its element segment applied at instantiation
// like any ordinary module's, which is exactly the behaviour that was missing.
//
// Why the rewrite is safe without relocating anything:
//
//   - memory and table each have their own index space, and this module is the only user of
//     both, so removing their imports leaves memory 0 and table 0 pointing at the same slots
//     every instruction already refers to;
//   - function and global index spaces are untouched, because a memory import and a table
//     import occupy neither.
//
// So every bytecode offset, call_indirect type and global reference stays valid.

import (
	"fmt"
)

// wasm section ids.
const (
	secType     = 1
	secImport   = 2
	secFunction = 3
	secTable    = 4
	secMemory   = 5
	secGlobal   = 6
	secExport   = 7
)

// import kinds.
const (
	kindFunc   = 0x00
	kindTable  = 0x01
	kindMemory = 0x02
	kindGlobal = 0x03
)

// wasmSection is one raw section: its id and its body (without the length prefix).
type wasmSection struct {
	id   byte
	body []byte
}

// transformOwnsMemoryAndTable rewrites the parser module.
//
// The result declares its own memory (min/max) and its own funcref table, exports both, and
// imports neither.
func transformOwnsMemoryAndTable(module []byte, tableMin uint32) ([]byte, error) {
	sections, err := splitSections(module)
	if err != nil {
		return nil, err
	}

	byID := map[byte]*wasmSection{}
	for i := range sections {
		section := &sections[i]
		// A module with two sections of the same id is malformed; the last wins is fine
		// here because none of the ids we read can legally repeat.
		byID[section.id] = section
	}
	for _, required := range []byte{secType, secImport, secFunction, secExport} {
		if byID[required] == nil {
			return nil, fmt.Errorf("cgwasm: parser module has no section %d", required)
		}
	}

	// Import section, minus the memory and table imports.
	imports, err := rewriteImports(byID[secImport].body)
	if err != nil {
		return nil, err
	}
	byID[secImport] = &wasmSection{id: secImport, body: imports}

	// Memory section: one memory, the geometry the parser declared.
	byID[secMemory] = &wasmSection{id: secMemory, body: encodeMemorySection(shimMemoryPages, shimMemoryMaxPages)}

	// Table section: one funcref table.
	if byID[secTable] == nil {
		byID[secTable] = &wasmSection{id: secTable, body: encodeTableSection(tableMin)}
	}

	// Export section: add `memory` and `__indirect_function_table`.
	exports, err := appendExports(byID[secExport].body, []wasmExport{
		{name: "memory", kind: kindMemory, index: 0},
		{name: "__indirect_function_table", kind: kindTable, index: 0},
	})
	if err != nil {
		return nil, err
	}
	byID[secExport] = &wasmSection{id: secExport, body: exports}

	// Emit in the order the format requires.
	//
	// This is almost ascending id, with one exception: the DataCount section (id 12) must
	// come BEFORE Code (10) and Data (11). Emitting in plain numeric order is rejected with
	// "invalid section order", which is easy to misread as a duplicate-section problem.
	out := []byte{0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00}
	for _, id := range canonicalSectionOrder {
		section, ok := byID[id]
		if !ok {
			continue
		}
		out = appendSection(out, section.id, section.body)
	}
	// Any section id outside the canonical list is emitted last rather than dropped.
	for id := range byID {
		if canonicalIndex(id) >= 0 {
			continue
		}
		section := byID[id]
		out = appendSection(out, section.id, section.body)
	}
	return out, nil
}

// splitSections parses the section table.
func splitSections(module []byte) ([]wasmSection, error) {
	if len(module) < 8 || string(module[:4]) != "\x00asm" {
		return nil, errShortModule
	}
	var out []wasmSection
	for i := 8; i < len(module); {
		id := module[i]
		i++
		size, next, err := readULEB(module, i)
		if err != nil {
			return out, err
		}
		i = next
		end := i + int(size)
		if end > len(module) {
			return out, fmt.Errorf("cgwasm: section %d runs past the module", id)
		}
		body := make([]byte, size)
		copy(body, module[i:end])
		i = end
		out = append(out, wasmSection{id: id, body: body})
	}
	return out, nil
}

// rewriteImports re-encodes the import section without the memory and table entries.
//
// Every other entry is copied verbatim: an import's encoding is self-delimiting, so skipping
// the two we do not want needs no interpretation of the rest.
func rewriteImports(body []byte) ([]byte, error) {
	count, p, err := readULEB(body, 0)
	if err != nil {
		return nil, err
	}
	kept := make([][]byte, 0, count)
	for n := uint32(0); n < count; n++ {
		start := p
		var moduleLen uint32
		moduleLen, p, err = readULEB(body, p)
		if err != nil {
			return nil, err
		}
		p += int(moduleLen)
		var nameLen uint32
		nameLen, p, err = readULEB(body, p)
		if err != nil {
			return nil, err
		}
		p += int(nameLen)
		if p >= len(body) {
			return nil, errTruncatedSection
		}
		kind := body[p]
		p++
		switch kind {
		case kindFunc:
			var t uint32
			t, p, err = readULEB(body, p)
			if err != nil {
				return nil, err
			}
			_ = t
		case kindTable:
			// reftype + limits
			p++ // element type
			p, err = skipLimits(body, p)
			if err != nil {
				return nil, err
			}
		case kindMemory:
			p, err = skipLimits(body, p)
			if err != nil {
				return nil, err
			}
		case kindGlobal:
			p += 2 // value type + mutability
		default:
			return nil, fmt.Errorf("cgwasm: import kind %#x in the parser module", kind)
		}
		if p > len(body) {
			return nil, errTruncatedSection
		}
		if kind == kindMemory || kind == kindTable {
			// Dropped: the module will define them itself.
			continue
		}
		kept = append(kept, body[start:p])
	}

	out := make([]byte, 0, len(body))
	out = appendULEB(out, uint32(len(kept)))
	for _, entry := range kept {
		out = append(out, entry...)
	}
	return out, nil
}

// skipLimits advances past a limits encoding.
func skipLimits(body []byte, p int) (int, error) {
	if p >= len(body) {
		return p, errTruncatedSection
	}
	flags := body[p]
	p++
	_, next, err := readULEB(body, p)
	if err != nil {
		return p, err
	}
	p = next
	if flags&0x01 != 0 {
		_, next, err = readULEB(body, p)
		if err != nil {
			return p, err
		}
		p = next
	}
	return p, nil
}

// wasmExport is one entry of an export section.
type wasmExport struct {
	name  string
	kind  byte
	index uint32
}

// appendExports re-encodes the export section with extra entries, skipping duplicates.
func appendExports(body []byte, extra []wasmExport) ([]byte, error) {
	count, p, err := readULEB(body, 0)
	if err != nil {
		return nil, err
	}
	entries := make([][]byte, 0, count+uint32(len(extra)))
	existing := map[string]bool{}
	for n := uint32(0); n < count; n++ {
		start := p
		var nameLen uint32
		nameLen, p, err = readULEB(body, p)
		if err != nil {
			return nil, err
		}
		name := string(body[p : p+int(nameLen)])
		p += int(nameLen)
		p += 1 // kind
		_, next, err := readULEB(body, p)
		if err != nil {
			return nil, err
		}
		p = next
		if p > len(body) {
			return nil, errTruncatedSection
		}
		existing[name] = true
		entries = append(entries, body[start:p])
	}

	for _, export := range extra {
		if existing[export.name] {
			continue
		}
		var entry []byte
		entry = appendName(entry, export.name)
		entry = append(entry, export.kind)
		entry = appendULEB(entry, export.index)
		entries = append(entries, entry)
	}

	out := make([]byte, 0, len(body)+64)
	out = appendULEB(out, uint32(len(entries)))
	for _, entry := range entries {
		out = append(out, entry...)
	}
	return out, nil
}

// encodeMemorySection writes a memory section with one memory.
func encodeMemorySection(min, max uint32) []byte {
	var body []byte
	body = appendULEB(body, 1) // count
	body = append(body, 0x01)  // limits with max
	body = appendULEB(body, min)
	body = appendULEB(body, max)
	return body
}

// encodeTableSection writes a table section with one funcref table.
func encodeTableSection(min uint32) []byte {
	var body []byte
	body = appendULEB(body, 1)   // count
	body = append(body, refFunc) // element type
	body = append(body, 0x01)    // limits with max, so the module can grow it
	body = appendULEB(body, min)
	body = appendULEB(body, min*4)
	return body
}

// canonicalSectionOrder is the sequence the wasm format requires sections to appear in.
//
// It is ascending id except for DataCount (12), which precedes Code (10) and Data (11).
var canonicalSectionOrder = []byte{
	1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 10, 11,
}

// canonicalIndex returns the position of a section id in canonicalSectionOrder, or -1.
func canonicalIndex(id byte) int {
	for i, want := range canonicalSectionOrder {
		if want == id {
			return i
		}
	}
	return -1
}
