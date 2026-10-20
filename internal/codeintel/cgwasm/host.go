// Package cgwasm drives tree-sitter through WebAssembly: the fallback extractor for files
// the native Rust kernel declines.
//
// Why a fallback exists at all: the kernel parses 20 languages in compiled code and its
// output is byte-identical to the reference engine, but when a file's parse tree contains
// errors it hands the file back with a `defer:` message instead of guessing. Macro-heavy C
// is the case that hits this constantly 鈥?uthash's `uthash.h` is almost entirely macros, and
// the kernel declines 45 of that project's 119 files. The WASM build of tree-sitter has a
// recovery mode that the native one does not, so this package is that recovery path.
//
// It calls tree-sitter's real C API rather than reimplementing a parser:
//
//	tree-sitter.wasm      exports the full ts_* API (153 functions)
//	tree-sitter-c.wasm    exports one function returning the TSLanguage pointer
//	tree-sitter-cpp.wasm  likewise
//
// Two things about the calling convention are not obvious and cost real time to discover:
//
//  1. **Struct-returning functions take their destination implicitly.** `ts_tree_root_node_wasm`
//     takes ONE argument and returns nothing; it writes a 20-byte node record to a fixed
//     transfer buffer whose address `ts_init()` returns. Every node-returning call works that
//     way, so marshalNode/unmarshalNode is the whole interface.
//
//  2. **The parser module imports its memory from `env`.** wazero's host-module builder can
//     export functions but not memory, so `env` is supplied by a small WASM shim (see
//     shim.go) that defines the memory and re-exports the host functions. Without that shim
//     instantiation fails with `module[env] not instantiated`.
//
// # Current state: not wired in
//
// `New` now gets all the way to `ts_parser_set_language`, which rejects the grammar. The
// blocker is the one piece of dynamic linking this package does not implement:
//
//	The parser and the grammar are SIDE MODULES that share one memory and one function
//	table. Each imports `env.memory`, `env.__indirect_function_table` and — the part that
//	matters — its own `env.__memory_base`, the offset in the shared memory where that
//	module's data begins. A shim can export only ONE value per global, so the grammar ends
//	up told to place its data where the parser's data already is, and the instruction
//	pointer it returns (`tree_sitter_c()`) does not describe a TSLanguage in the parser's
//	address space. `ts_language_version` answers zero, which surfaces as "grammar is
//	incompatible".
//
// What that requires, concretely: rewriting each module's `global.get N` references to
// `i32.const <per-module base>` so the two can be relocated independently, then assigning
// disjoint data ranges (and a table range for the grammar) in the shared memory. It is a
// code-section rewrite, not another shim.
//
// Progress along the way, each step pinned by a test or a comment:
//
//   - the shim assembles into a valid module (TestShimAssembles);
//   - the layout globals are derived from the parser's own data segments
//     (TestLayoutFromDataSegments);
//   - the parser is rewritten to OWN its memory and table, which fixes the empty imported
//     table (transform.go);
//   - the grammar needs `__wasm_call_ctors` and `__wasm_apply_data_relocs` called before its
//     factory, or its tables are unrelocated (languagePointer);
//   - the parse callback WRITES UTF-16 into a buffer it is given, and does not return a
//     pointer (serveSource).
//
// The indexer does not call this package, so a build without it behaves exactly as before.
package cgwasm

import (
	"context"
	"embed"
	"fmt"
	"os"
	"sync"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// grammarFS carries the compiled grammars beside the code, so the fallback works with no
// external file and without the npm package installed.
//
//go:embed wasm/tree-sitter.wasm wasm/tree-sitter-c.wasm wasm/tree-sitter-cpp.wasm
var grammarFS embed.FS

// SizeOfInt is the wasm32 word size: every field of every marshalled struct is one.
const SizeOfInt = 4

// nodeFields is how many i32 words one marshalled node occupies:
//
//	id, startByte, startRow, startColumn, other
//
// The layout comes from web-tree-sitter's `unmarshalNode`. Several struct-returning calls
// take their destination implicitly, so this is the shape written into the transfer buffer.
const nodeFields = 5

// Node is one node of the syntax tree, decoded from the transfer buffer.
//
// The fields are the ones extraction needs: where the node starts and ends, and what kind
// it is. `Type` is resolved through the language's symbol table rather than read as a
// string pointer, because tree-sitter's wasm build exposes only `ts_node_symbol_wasm` 鈥?the
// symbol id 鈥?plus the language-level name lookup.
type Node struct {
	ID        uint32
	StartByte uint32
	StartRow  uint32
	StartCol  uint32
	// Other is the fifth marshalled word; the cursor variants use it for the end offset.
	Other uint32
	// Type is the grammar's node type name (`function_definition`, `call_expression`).
	Type string
	// Named reports whether the node is a named node. Anonymous nodes are punctuation, and
	// extraction walks only named ones.
	Named bool
}

// Host is one instantiated tree-sitter runtime with one grammar loaded.
//
// Not safe for concurrent use: the parser and the transfer buffer are module state. Callers
// pool hosts, one per goroutine.
type Host struct {
	ctx        context.Context
	rt         wazero.Runtime
	shimMod    api.Module
	parserMod  api.Module
	grammarMod api.Module
	memory     api.Memory
	transfer   uint32
	language   uint32
	parser     uint32
	languageID string

	// sourceUTF16 holds the current file as UTF-16LE, and sourceUnits is its length in code
	// units. The parse callback serves slices of it.
	sourceUTF16 []byte
	sourceUnits uint32

	closeOnce sync.Once
}

// grammarFile maps a language to its embedded grammar.
var grammarFile = map[string]string{
	"c":   "wasm/tree-sitter-c.wasm",
	"cpp": "wasm/tree-sitter-cpp.wasm",
}

// Languages lists what the fallback can parse.
func Languages() []string { return []string{"c", "cpp"} }

// New instantiates the runtime with one grammar.
//
// An unknown language is an error rather than a silent fallback to C: extracting C++ as C
// produces a tree that is wrong in ways the caller cannot see.
func New(ctx context.Context, language string) (*Host, error) {
	file, ok := grammarFile[language]
	if !ok {
		return nil, fmt.Errorf("cgwasm: no grammar for %q (have c, cpp)", language)
	}
	parserBytes, err := grammarFS.ReadFile("wasm/tree-sitter.wasm")
	if err != nil {
		return nil, fmt.Errorf("cgwasm: read parser: %w", err)
	}
	grammarBytes, err := grammarFS.ReadFile(file)
	if err != nil {
		return nil, fmt.Errorf("cgwasm: read grammar %s: %w", file, err)
	}

	h := &Host{ctx: ctx, languageID: language}
	// CoreFeaturesV2 enables the post-MVP proposals the emscripten build uses: reference
	// types and bulk memory, both of which the indirect function table's setup needs.
	h.rt = wazero.NewRuntimeWithConfig(ctx,
		wazero.NewRuntimeConfig().WithCoreFeatures(api.CoreFeaturesV2))
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, h.rt); err != nil {
		h.Close()
		return nil, fmt.Errorf("cgwasm: wasi: %w", err)
	}

	// Step 1: the host module carrying the callbacks, under a name the shim imports from.
	if _, err := h.newHostModule(); err != nil {
		h.Close()
		return nil, err
	}

	// Step 2: the layout this dylink build expects its loader to provide, read from the
	// parser's own data segments.
	layout, err := computeLayout(parserBytes)
	if err != nil {
		h.Close()
		return nil, fmt.Errorf("cgwasm: compute layout: %w", err)
	}

	// Step 3: `GOT.mem`, which supplies `__heap_base`.
	if _, err := h.rt.InstantiateWithConfig(ctx, buildGotMem(layout),
		wazero.NewModuleConfig().WithName("GOT.mem")); err != nil {
		h.Close()
		return nil, fmt.Errorf("cgwasm: instantiate GOT.mem: %w", err)
	}

	// Step 4: the shim, which supplies `env` (memory, table, layout globals and the
	// re-exported callbacks).
	shim, err := h.rt.InstantiateWithConfig(ctx, buildEnvShim(layout), wazero.NewModuleConfig().WithName("env"))
	if err != nil {
		h.Close()
		return nil, fmt.Errorf("cgwasm: instantiate env shim: %w", err)
	}
	h.shimMod = shim

	// Step 5: the parser.
	// The parser must own its memory and function table: wazero does not apply an imported
	// table's active element segment, and exposes no Table API to fill it by hand. See
	// transform.go.
	parserBytes, err = transformOwnsMemoryAndTable(parserBytes, shimTableMin)
	if err != nil {
		h.Close()
		return nil, fmt.Errorf("cgwasm: transform parser: %w", err)
	}
	h.parserMod, err = h.rt.InstantiateWithConfig(ctx, parserBytes,
		wazero.NewModuleConfig().WithName("tree-sitter"))
	if err != nil {
		h.Close()
		return nil, fmt.Errorf("cgwasm: instantiate parser: %w", err)
	}
	h.memory = h.parserMod.ExportedMemory("memory")
	if h.memory == nil {
		h.Close()
		return nil, fmt.Errorf("cgwasm: transformed parser exports no memory")
	}

	tsInit := h.parserMod.ExportedFunction("ts_init")
	if tsInit == nil {
		h.Close()
		return nil, fmt.Errorf("cgwasm: parser exports no ts_init")
	}
	out, err := tsInit.Call(ctx)
	if err != nil {
		h.Close()
		return nil, fmt.Errorf("cgwasm: ts_init: %w", err)
	}
	if len(out) != 1 || out[0] == 0 {
		h.Close()
		return nil, fmt.Errorf("cgwasm: ts_init returned no transfer buffer")
	}
	h.transfer = uint32(out[0])

	// Step 6: the grammar.
	h.grammarMod, err = h.rt.InstantiateWithConfig(ctx, grammarBytes,
		wazero.NewModuleConfig().WithName("grammar-"+language))
	if err != nil {
		h.Close()
		return nil, fmt.Errorf("cgwasm: instantiate grammar: %w", err)
	}
	if h.language, err = h.languagePointer(); err != nil {
		h.Close()
		return nil, err
	}

	// Step 7: the parser instance, with the language attached.
	tsParserNew := h.parserMod.ExportedFunction("ts_parser_new_wasm")
	if tsParserNew == nil {
		h.Close()
		return nil, fmt.Errorf("cgwasm: parser exports no ts_parser_new_wasm")
	}
	if _, err := tsParserNew.Call(ctx); err != nil {
		h.Close()
		return nil, fmt.Errorf("cgwasm: ts_parser_new_wasm: %w", err)
	}
	h.parser = h.readU32(h.transfer)
	if h.parser == 0 {
		h.Close()
		return nil, fmt.Errorf("cgwasm: ts_parser_new_wasm produced a null parser")
	}

	tsSetLanguage := h.parserMod.ExportedFunction("ts_parser_set_language")
	if tsSetLanguage == nil {
		h.Close()
		return nil, fmt.Errorf("cgwasm: parser exports no ts_parser_set_language")
	}
	out, err = tsSetLanguage.Call(ctx, uint64(h.parser), uint64(h.language))
	if err != nil {
		h.Close()
		return nil, fmt.Errorf("cgwasm: ts_parser_set_language: %w", err)
	}
	if len(out) == 1 && out[0] == 0 {
		if os.Getenv("CGWASM_DEBUG") != "" {
			// The comparison that failed: the parser's own version against the grammar's.
			parserVersion := h.readU32(h.transfer)
			minCompatible := h.readU32(h.transfer + 4)
			grammarVersion := uint32(0)
			if fn := h.parserMod.ExportedFunction("ts_language_version"); fn != nil {
				if r, err := fn.Call(ctx, uint64(h.language)); err == nil && len(r) == 1 {
					grammarVersion = uint32(r[0])
				}
			}
			fmt.Fprintf(os.Stderr, "cgwasm debug: parser=%d minCompatible=%d grammar=%d languagePtr=%#x\n",
				parserVersion, minCompatible, grammarVersion, h.language)
		}
		h.Close()
		return nil, fmt.Errorf("cgwasm: grammar %q is incompatible with this parser", language)
	}

	return h, nil
}

// newHostModule defines the callbacks the shim re-exports.
//
// The module is named "host" rather than "env" precisely because "env" must be the shim:
// one module per name, and the parser imports from "env".
func (h *Host) newHostModule() (api.Module, error) {
	builder := h.rt.NewHostModuleBuilder("host")

	// The callbacks tree-sitter declares. Only the parse callback carries real work; the
	// others exist so the module instantiates.
	builder.NewFunctionBuilder().WithFunc(
		func(ctx context.Context, mod api.Module, inputBuffer, index, row, column, lengthAddress uint32) {
			h.serveSource(inputBuffer, index, lengthAddress)
		}).Export("tree_sitter_parse_callback")
	builder.NewFunctionBuilder().WithFunc(
		func(ctx context.Context, mod api.Module, payload, code uint32) {}).
		Export("tree_sitter_log_callback")
	builder.NewFunctionBuilder().WithFunc(
		func(ctx context.Context, mod api.Module, payload, state uint32) uint32 { return 0 }).
		Export("tree_sitter_progress_callback")
	builder.NewFunctionBuilder().WithFunc(
		func(ctx context.Context, mod api.Module, payload uint32) uint32 { return 0 }).
		Export("tree_sitter_query_progress_callback")
	builder.NewFunctionBuilder().WithFunc(
		func(ctx context.Context, mod api.Module) {}).Export("_abort_js")
	builder.NewFunctionBuilder().WithFunc(
		func(ctx context.Context, mod api.Module, size uint32) uint32 { return 0 }).
		Export("emscripten_resize_heap")

	// The C++ grammar's scanner resolves these C library calls to the host.
	builder.NewFunctionBuilder().WithFunc(
		func(ctx context.Context, mod api.Module, count, size uint32) uint32 {
			total := count * size
			if total == 0 {
				total = 1
			}
			addr, err := h.allocate(total)
			if err != nil {
				return 0
			}
			// calloc must zero, and the wasm heap is not guaranteed zeroed after reuse.
			zero := make([]byte, total)
			h.memory.Write(addr, zero)
			return addr
		}).Export("calloc")
	builder.NewFunctionBuilder().WithFunc(
		func(ctx context.Context, mod api.Module, addr uint32) {}).Export("free")
	builder.NewFunctionBuilder().WithFunc(
		func(ctx context.Context, mod api.Module, r uint32) uint32 {
			// iswspace for the wide characters the C++ scanner asks about.
			switch r {
			case ' ', '\t', '\n', '\v', '\f', '\r':
				return 1
			}
			return 0
		}).Export("iswspace")
	builder.NewFunctionBuilder().WithFunc(
		func(ctx context.Context, mod api.Module, a, b, c, d uint32) {}).Export("__assert_fail")

	return builder.Instantiate(h.ctx)
}

// serveSource answers one parse-callback invocation.
//
// The contract: return a pointer to the source from `byteIndex` onward, and write how many
// bytes are available into `bytesReadOut`. A zero length means end of input.
// serveSource answers one parse-callback invocation.
//
// The contract is NOT "return a pointer to the text" — web-tree-sitter's binding is
//
//	_tree_sitter_parse_callback(inputBufferAddress, index, row, column, lengthAddress)
//
// and the host WRITES the next chunk into the buffer it is handed, then reports how many
// units it wrote. The text is UTF-16 (one code unit per two bytes), which is what the wasm
// build's reader expects, so the source is converted once in writeSource and served from
// there.
//
// `index` is a UTF-16 code-unit offset, not a byte offset — the JS binding slices a string
// with it — so the buffer slice is index*2 in the byte array.
func (h *Host) serveSource(inputBuffer, index, lengthAddress uint32) {
	if index >= h.sourceUnits {
		h.writeU32(lengthAddress, 0)
		return
	}
	available := h.sourceUnits - index
	// emscripten's INPUT_BUFFER_SIZE is 10 KiB of UTF-16, i.e. 5120 code units. Writing more
	// than the caller's buffer holds would corrupt its stack.
	const maxUnits = 10 * 1024 / 2
	copyUnits := available
	if copyUnits > maxUnits {
		copyUnits = maxUnits
	}
	from := index * 2
	to := from + copyUnits*2
	if to > uint32(len(h.sourceUTF16)) {
		to = uint32(len(h.sourceUTF16))
		copyUnits = (to - from) / 2
	}
	if copyUnits == 0 {
		h.writeU32(lengthAddress, 0)
		return
	}
	h.memory.Write(inputBuffer, h.sourceUTF16[from:to])
	h.writeU32(lengthAddress, copyUnits)
}

// languagePointer initialises the grammar module and returns its TSLanguage.
//
// Three things have to happen, in this order, and skipping any of them yields a pointer that
// looks valid but is not a language:
//
//  1. `__wasm_call_ctors` — the grammar is a dylink reactor, so its constructors are NOT run
//     at instantiation. Without this call the language's tables are unrelocated and
//     `ts_language_version` reports zero, which surfaces as "grammar is incompatible".
//  2. `__wasm_apply_data_relocs` — the same reason, for the data segment's relocations.
//  3. `tree_sitter_<lang>` — the factory. Its name is stable in every tree-sitter grammar;
//     the signature scan is only a fallback for a build that strips it.
func (h *Host) languagePointer() (uint32, error) {
	for _, name := range []string{"__wasm_call_ctors", "__wasm_apply_data_relocs"} {
		if fn := h.grammarMod.ExportedFunction(name); fn != nil {
			if _, err := fn.Call(h.ctx); err != nil {
				return 0, fmt.Errorf("cgwasm: grammar %s: %s: %w", h.languageID, name, err)
			}
		}
	}

	if fn := h.grammarMod.ExportedFunction("tree_sitter_" + h.languageID); fn != nil {
		out, err := fn.Call(h.ctx)
		if err != nil {
			return 0, fmt.Errorf("cgwasm: grammar factory: %w", err)
		}
		if len(out) == 1 && out[0] != 0 {
			return uint32(out[0]), nil
		}
		return 0, fmt.Errorf("cgwasm: grammar %s factory returned null", h.languageID)
	}

	// Fallback: match by signature, for a build whose factory lost its name.
	for name, def := range h.grammarMod.ExportedFunctionDefinitions() {
		if name == "" || len(def.ResultTypes()) != 1 {
			continue
		}
		fn := h.grammarMod.ExportedFunction(name)
		if fn == nil {
			continue
		}
		out, err := fn.Call(h.ctx)
		if err != nil || len(out) != 1 || out[0] == 0 {
			continue
		}
		return uint32(out[0]), nil
	}
	return 0, fmt.Errorf("cgwasm: grammar %s exports no language factory", h.languageID)
}

// Close releases the runtime.
func (h *Host) Close() error {
	var err error
	h.closeOnce.Do(func() {
		if h.rt != nil {
			err = h.rt.Close(h.ctx)
		}
	})
	return err
}

// readU32 reads one little-endian word.
func (h *Host) readU32(addr uint32) uint32 {
	raw, ok := h.memory.Read(addr, SizeOfInt)
	if !ok || len(raw) < SizeOfInt {
		return 0
	}
	return uint32(raw[0]) | uint32(raw[1])<<8 | uint32(raw[2])<<16 | uint32(raw[3])<<24
}

// writeU32 writes one little-endian word.
func (h *Host) writeU32(addr, value uint32) bool {
	return h.memory.WriteUint32Le(addr, value)
}

// readCString reads a NUL-terminated UTF-8 string.
func (h *Host) readCString(addr uint32) string {
	if addr == 0 {
		return ""
	}
	out := make([]byte, 0, 64)
	for offset := uint32(0); offset < 1<<16; offset += 32 {
		chunk, ok := h.memory.Read(addr+offset, 32)
		if !ok {
			break
		}
		for _, b := range chunk {
			if b == 0 {
				return string(out)
			}
			out = append(out, b)
		}
	}
	return string(out)
}

// allocate reserves memory through the parser's own allocator.
//
// Going through the module's `dlmalloc` rather than a Go-side arena is what keeps a pointer
// handed back to C valid: the parser's allocator owns the whole heap.
func (h *Host) allocate(n uint32) (uint32, error) {
	for _, name := range []string{"dlmalloc", "malloc"} {
		fn := h.parserMod.ExportedFunction(name)
		if fn == nil {
			continue
		}
		out, err := fn.Call(h.ctx, uint64(n))
		if err != nil {
			return 0, err
		}
		if len(out) == 1 && out[0] != 0 {
			return uint32(out[0]), nil
		}
	}
	return 0, fmt.Errorf("cgwasm: no allocator available")
}

// writeSource copies the file's bytes into wasm memory, growing the buffer if needed.
// writeSource converts the file to UTF-16 and keeps it for the parse callback.
//
// No copy is made into wasm memory up front: the callback hands tree-sitter a bounded chunk
// at a time, so the source lives on the Go heap and crosses the boundary 10 KiB at a time.
func (h *Host) writeSource(data []byte) error {
	h.sourceUTF16 = h.sourceUTF16[:0]
	for _, r := range string(data) {
		if r > 0xFFFF {
			// A supplementary character becomes a surrogate pair, which is two units.
			r -= 0x10000
			high := uint16(0xD800 + (r >> 10))
			low := uint16(0xDC00 + (r & 0x3FF))
			h.sourceUTF16 = append(h.sourceUTF16, byte(high), byte(high>>8), byte(low), byte(low>>8))
			continue
		}
		h.sourceUTF16 = append(h.sourceUTF16, byte(r), byte(r>>8))
	}
	h.sourceUnits = uint32(len(h.sourceUTF16) / 2)
	return nil
}
