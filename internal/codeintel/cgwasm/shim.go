package cgwasm

// The `env` module, assembled as WASM bytes, plus the `GOT.mem` stub it needs.
//
// tree-sitter.wasm is a DYNAMIC (dylink) build: it imports its memory AND the layout globals
// that an emscripten loader would normally supply. Sixteen imports, in full:
//
//	env.tree_sitter_{log,parse,progress,query_progress}_callback   the host callbacks
//	env._abort_js, env.emscripten_resize_heap                     emscripten helpers
//	wasi_snapshot_preview1.{fd_close,fd_write,clock_time_get,fd_seek}   wazero provides these
//	env.__stack_pointer      (mut i32)  the C stack top
//	env.__memory_base        (i32)      where static data starts
//	env.__table_base         (i32)      where the function table starts
//	GOT.mem.__heap_base      (mut i32)  where the heap begins
//	env.memory               (min 512, max 32768 pages)
//	env.__indirect_function_table (funcref, min 30)
//
// wazero's host-module builder exports functions only 鈥?no memory, no globals, no tables.
// So `env` cannot be a host module, and this file builds it as real WASM instead:
//
//	host (wazero)   the Go callbacks
//	  鈫?import
//	env (here)      memory + table + layout globals, re-exporting the callbacks
//	  鈫?import
//	tree-sitter.wasm
//
// The layout values are computed from the parser's own data segments: `__heap_base` must sit
// above the last byte of static data or dlmalloc will hand out memory that already holds the
// module's globals, and the failure looks like a corrupt parse tree rather than an allocation
// error. See staticDataEnd.

// shimImports lists the host functions the shim forwards, with their signatures.
//
// The signatures are read off tree-sitter.wasm's import section and must match exactly:
// wasm checks the type at link time, and a mismatch is a link error rather than a wrong
// answer, which is the good outcome.
var shimImports = []struct {
	name    string
	params  []byte
	results []byte
}{
	{"tree_sitter_log_callback", []byte{valI32, valI32}, nil},
	// The parse callback takes five arguments and returns nothing: web-tree-sitter's binding
	// is `(inputBufferAddress, index, row, column, lengthAddress)`, and the host WRITES the
	// text into the buffer it is given. See host.go's serveSource.
	{"tree_sitter_parse_callback", []byte{valI32, valI32, valI32, valI32, valI32}, nil},
	{"tree_sitter_progress_callback", []byte{valI32, valI32}, []byte{valI32}},
	{"tree_sitter_query_progress_callback", []byte{valI32}, []byte{valI32}},
	{"_abort_js", nil, nil},
	{"emscripten_resize_heap", []byte{valI32}, []byte{valI32}},
	{"calloc", []byte{valI32, valI32}, []byte{valI32}},
	{"free", []byte{valI32}, nil},
	{"iswspace", []byte{valI32}, []byte{valI32}},
	{"__assert_fail", []byte{valI32, valI32, valI32, valI32}, nil},
}

// Memory geometry.
const (
	// shimMemoryPages is the memory's minimum, which must satisfy the parser's import
	// (min 512 pages = 32 MiB, max 32768 pages = 2 GiB).
	shimMemoryPages = 512
	// shimMemoryMaxPages matches the parser's declared maximum.
	shimMemoryMaxPages = 32768
	// shimTableMin is the function table's minimum: the parser declares 30 slots.
	shimTableMin = 30
	// stackSlack is how much of the top of memory the C stack gets.
	//
	// The stack grows DOWN from `__stack_pointer`, so a generous slack is free; a tight one
	// is a stack overflow inside tree-sitter's recursive descent. 1 MiB.
	stackSlack = 1 << 20
)

// wasm value types and kinds used by the encoder.
const (
	valI32  byte = 0x7F
	valI64  byte = 0x7E
	refFunc byte = 0x70
)

// shimLayout carries the addresses the shim must export.
type shimLayout struct {
	// heapBase is where dlmalloc may start handing out memory.
	heapBase uint32
	// stackPointer is the top of the C stack.
	stackPointer uint32
}

// buildEnvShim assembles the `env` module.
func buildEnvShim(layout shimLayout) []byte {
	// Deduplicate the function types: several imports share a signature.
	type signature struct{ params, results string }
	typeIndex := map[signature]uint32{}
	var types []signature
	for _, imp := range shimImports {
		sig := signature{string(imp.params), string(imp.results)}
		if _, ok := typeIndex[sig]; ok {
			continue
		}
		typeIndex[sig] = uint32(len(types))
		types = append(types, sig)
	}

	var out []byte
	out = append(out, 0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00) // magic + version

	// Type section.
	var typeSection []byte
	typeSection = appendULEB(typeSection, uint32(len(types)))
	for _, t := range types {
		typeSection = append(typeSection, 0x60)
		typeSection = appendULEB(typeSection, uint32(len(t.params)))
		typeSection = append(typeSection, t.params...)
		typeSection = appendULEB(typeSection, uint32(len(t.results)))
		typeSection = append(typeSection, t.results...)
	}
	out = appendSection(out, 1, typeSection)

	// Import section: every function comes from `host`.
	var importSection []byte
	importSection = appendULEB(importSection, uint32(len(shimImports)))
	for _, imp := range shimImports {
		importSection = appendName(importSection, "host")
		importSection = appendName(importSection, imp.name)
		importSection = append(importSection, 0x00) // kind: function
		importSection = appendULEB(importSection, typeIndex[signature{string(imp.params), string(imp.results)}])
	}
	out = appendSection(out, 2, importSection)

	// Table section: one funcref table, which the parser's indirect calls need.
	var tableSection []byte
	tableSection = appendULEB(tableSection, 1)   // count
	tableSection = append(tableSection, refFunc) // element type
	tableSection = append(tableSection, 0x00)    // limits: min only
	tableSection = appendULEB(tableSection, shimTableMin)
	out = appendSection(out, 4, tableSection)

	// Memory section: the whole point of this module.
	var memorySection []byte
	memorySection = appendULEB(memorySection, 1) // count
	memorySection = append(memorySection, 0x01)  // limits with max
	memorySection = appendULEB(memorySection, shimMemoryPages)
	memorySection = appendULEB(memorySection, shimMemoryMaxPages)
	out = appendSection(out, 5, memorySection)

	// Global section: the layout the dylink build expects its loader to provide.
	//
	// `__stack_pointer` is mutable because the module adjusts it while running;
	// `__memory_base` and `__table_base` are constants, both zero because this module owns
	// the whole address space.
	var globalSection []byte
	globalSection = appendULEB(globalSection, 3) // count
	globalSection = append(globalSection, valI32, 0x01)
	globalSection = appendInitI32(globalSection, layout.stackPointer)
	globalSection = append(globalSection, valI32, 0x00)
	globalSection = appendInitI32(globalSection, 0)
	globalSection = append(globalSection, valI32, 0x00)
	globalSection = appendInitI32(globalSection, 0)
	out = appendSection(out, 6, globalSection)

	// Export section: the callbacks (indices are their import positions, since this module
	// defines no functions of its own), then the globals, table and memory.
	var exportSection []byte
	total := len(shimImports) + 5
	exportSection = appendULEB(exportSection, uint32(total))
	for index, imp := range shimImports {
		exportSection = appendName(exportSection, imp.name)
		exportSection = append(exportSection, 0x00) // kind: function
		exportSection = appendULEB(exportSection, uint32(index))
	}
	exportSection = appendName(exportSection, "__stack_pointer")
	exportSection = append(exportSection, 0x03) // kind: global
	exportSection = appendULEB(exportSection, 0)
	exportSection = appendName(exportSection, "__memory_base")
	exportSection = append(exportSection, 0x03)
	exportSection = appendULEB(exportSection, 1)
	exportSection = appendName(exportSection, "__table_base")
	exportSection = append(exportSection, 0x03)
	exportSection = appendULEB(exportSection, 2)
	exportSection = appendName(exportSection, "__indirect_function_table")
	exportSection = append(exportSection, 0x01) // kind: table
	exportSection = appendULEB(exportSection, 0)
	exportSection = appendName(exportSection, "memory")
	exportSection = append(exportSection, 0x02) // kind: memory
	exportSection = appendULEB(exportSection, 0)
	out = appendSection(out, 7, exportSection)

	return out
}

// buildGotMem assembles the `GOT.mem` module: one mutable i32 global, exported.
//
// The parser imports `__heap_base` from a module named `GOT.mem`, which is emscripten's
// convention for "the loader tells me where the heap starts". A module with a single global
// is all it takes.
func buildGotMem(layout shimLayout) []byte {
	var out []byte
	out = append(out, 0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00)

	var globalSection []byte
	globalSection = appendULEB(globalSection, 1)
	globalSection = append(globalSection, valI32, 0x01) // mutable
	globalSection = appendInitI32(globalSection, layout.heapBase)
	out = appendSection(out, 6, globalSection)

	var exportSection []byte
	exportSection = appendULEB(exportSection, 1)
	exportSection = appendName(exportSection, "__heap_base")
	exportSection = append(exportSection, 0x03) // kind: global
	exportSection = appendULEB(exportSection, 0)
	out = appendSection(out, 7, exportSection)

	return out
}

// appendSection writes one section: id, byte length, contents.
func appendSection(dst []byte, id byte, content []byte) []byte {
	dst = append(dst, id)
	dst = appendULEB(dst, uint32(len(content)))
	return append(dst, content...)
}

// appendName writes a length-prefixed UTF-8 name.
func appendName(dst []byte, name string) []byte {
	dst = appendULEB(dst, uint32(len(name)))
	return append(dst, name...)
}

// appendInitI32 writes an `i32.const value; end` initialiser expression.
func appendInitI32(dst []byte, value uint32) []byte {
	dst = append(dst, 0x41) // i32.const
	dst = appendSLEB(dst, int32(value))
	return append(dst, 0x0B) // end
}

// appendULEB writes an unsigned LEB128 integer.
func appendULEB(dst []byte, value uint32) []byte {
	for {
		b := byte(value & 0x7F)
		value >>= 7
		if value != 0 {
			b |= 0x80
		}
		dst = append(dst, b)
		if value == 0 {
			return dst
		}
	}
}

// appendSLEB writes a signed LEB128 integer.
func appendSLEB(dst []byte, value int32) []byte {
	for {
		b := byte(value & 0x7F)
		value >>= 7
		done := (value == 0 && b&0x40 == 0) || (value == -1 && b&0x40 != 0)
		if !done {
			b |= 0x80
		}
		dst = append(dst, b)
		if done {
			return dst
		}
	}
}
