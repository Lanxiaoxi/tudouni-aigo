package config

import (
	"bytes"
	"runtime"
	"unicode/utf8"
)

func isWindows() bool { return runtime.GOOS == "windows" }

// stripBOM removes a UTF-8 byte order mark.
//
// On Windows "save as UTF-8" frequently adds one, and a JSON parser then fails
// on the very first character with `Expecting value` — an invisible character
// causing a failure nobody can guess at.
func stripBOM(raw []byte) string {
	return string(bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF}))
}

func isValidUTF8(text string) bool { return utf8.ValidString(text) }
