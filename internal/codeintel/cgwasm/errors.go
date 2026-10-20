package cgwasm

import "errors"

// Errors the wasm parsing helpers return.
var (
	errShortModule        = errors.New("cgwasm: module shorter than a wasm header")
	errTruncatedSection   = errors.New("cgwasm: truncated section")
	errUnsupportedSegment = errors.New("cgwasm: unsupported data segment form")
	errLayoutTooSmall     = errors.New("cgwasm: static data leaves no room for the heap and stack")
)
