package cgwasm

// Computing the memory layout the dylink build expects its loader to provide.
//
// This is the part an emscripten loader does for you in a browser, and doing it here is why
// driving tree-sitter.wasm is not simply "call the C API". Two addresses matter:
//
//	__heap_base   where dlmalloc may start handing out memory. It must sit ABOVE the last
//	              byte of the module's static data, or an allocation lands on top of a
//	              global and the corruption shows up as a nonsense parse tree rather than
//	              an allocation failure.
//
//	__stack_pointer
//	              the top of the C stack, which grows downward. Set near the top of memory,
//	              leaving the heap the space between.
//
// The static data end is read from the module's own data section rather than guessed: a
// hardcoded value would be right for exactly one build of one grammar.

// dataSegment is one active data segment: where it starts and how large it is.
type dataSegment struct {
	offset uint32
	length uint32
}

// staticDataEnd returns the first address after the module's static data.
//
// Passive segments (flags 0x01) carry no address and are ignored: they are initialised by an
// explicit `memory.init` at runtime. Active segments are exactly what the linker placed.
func staticDataEnd(module []byte) (uint32, error) {
	segments, err := parseDataSegments(module)
	if err != nil {
		return 0, err
	}
	end := uint32(0)
	for _, seg := range segments {
		if stop := seg.offset + seg.length; stop > end {
			end = stop
		}
	}
	return end, nil
}

// parseDataSegments extracts the active data segments.
func parseDataSegments(module []byte) ([]dataSegment, error) {
	if len(module) < 8 {
		return nil, errShortModule
	}
	var out []dataSegment
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
			return out, errTruncatedSection
		}
		body := module[i:end]
		i = end
		if id != 11 { // data section
			continue
		}
		count, p, err := readULEB(body, 0)
		if err != nil {
			return out, err
		}
		for n := uint32(0); n < count; n++ {
			if p >= len(body) {
				return out, errTruncatedSection
			}
			flags := body[p]
			p++
			switch flags {
			case 0x00:
				// Active, memory 0: i32.const offset, end, bytes.
				offset, next, ok := readI32Const(body, p)
				if !ok {
					return out, errTruncatedSection
				}
				p = next
				length, next, err := readULEB(body, p)
				if err != nil {
					return out, err
				}
				p = next + int(length)
				out = append(out, dataSegment{offset: offset, length: length})
			case 0x01:
				// Passive: length-prefixed bytes, no address.
				length, next, err := readULEB(body, p)
				if err != nil {
					return out, err
				}
				p = next + int(length)
			case 0x02:
				// Active with an explicit memory index.
				_, next, err := readULEB(body, p)
				if err != nil {
					return out, err
				}
				p = next
				offset, next, ok := readI32Const(body, p)
				if !ok {
					return out, errTruncatedSection
				}
				p = next
				length, next, err := readULEB(body, p)
				if err != nil {
					return out, err
				}
				p = next + int(length)
				out = append(out, dataSegment{offset: offset, length: length})
			default:
				return out, errUnsupportedSegment
			}
			if p > len(body) {
				return out, errTruncatedSection
			}
		}
	}
	return out, nil
}

// readI32Const reads a constant initialiser expression and returns its value plus the offset
// after the terminating `end`.
//
// Two forms appear in a dylink build:
//
//	0x41 <sleb> 0x0B     i32.const N          a fixed offset
//	0x23 <uleb> 0x0B     global.get G        the offset relative to a base global
//
// The second is the one tree-sitter uses: its data segment is placed relative to
// `__memory_base`, which the loader sets to zero because this module owns the whole address
// space. So `global.get` resolves to the base's value — zero — and the segment starts at zero.
func readI32Const(body []byte, p int) (uint32, int, bool) {
	if p >= len(body) {
		return 0, p, false
	}
	var value uint32
	switch body[p] {
	case 0x41: // i32.const
		p++
		signed, next, err := readSLEB(body, p)
		if err != nil {
			return 0, p, false
		}
		p = next
		value = uint32(signed)
	case 0x23: // global.get — resolves to the base global, which is zero
		p++
		if _, next, err := readULEB(body, p); err != nil {
			return 0, p, false
		} else {
			p = next
		}
		value = 0
	default:
		return 0, p, false
	}
	if p >= len(body) || body[p] != 0x0B {
		return 0, p, false
	}
	return value, p + 1, true
}

// readULEB reads an unsigned LEB128 integer.
func readULEB(b []byte, i int) (uint32, int, error) {
	var v uint32
	var shift uint
	for {
		if i >= len(b) {
			return v, i, errTruncatedSection
		}
		c := b[i]
		i++
		v |= uint32(c&0x7F) << shift
		if c&0x80 == 0 {
			return v, i, nil
		}
		shift += 7
		if shift > 28 {
			return v, i, errUnsupportedSegment
		}
	}
}

// readSLEB reads a signed LEB128 integer.
func readSLEB(b []byte, i int) (int32, int, error) {
	var v int32
	var shift uint
	for {
		if i >= len(b) {
			return v, i, errTruncatedSection
		}
		c := b[i]
		i++
		v |= int32(c&0x7F) << shift
		shift += 7
		if c&0x80 == 0 {
			if shift < 32 && c&0x40 != 0 {
				v |= -1 << shift
			}
			return v, i, nil
		}
		if shift > 28 {
			return v, i, errUnsupportedSegment
		}
	}
}

// computeLayout derives the addresses the shim must export.
func computeLayout(parserModule []byte) (shimLayout, error) {
	staticEnd, err := staticDataEnd(parserModule)
	if err != nil {
		return shimLayout{}, err
	}
	// Round the heap base up to a double-word boundary: dlmalloc aligns its own blocks, but
	// starting from an unaligned base wastes a header and confuses nothing else.
	heapBase := (staticEnd + 15) &^ 15
	if heapBase == 0 {
		// A module with no data segments still needs a non-zero heap base, or every
		// allocation returns the null pointer.
		heapBase = 1024
	}

	total := uint32(shimMemoryPages) * 65536
	stackPointer := total - stackSlack
	if stackPointer <= heapBase {
		return shimLayout{}, errLayoutTooSmall
	}
	return shimLayout{heapBase: heapBase, stackPointer: stackPointer}, nil
}
