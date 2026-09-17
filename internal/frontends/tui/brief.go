package tui

import (
	"encoding/json"
	"fmt"
	"strings"
)

// jsonUnmarshalObject parses a tool-arguments string into a map. Failure is
// normal: the wire copy of a tool call's arguments is truncated for the audit
// trail, so most large payloads simply will not parse.
func jsonUnmarshalObject(text string, out *map[string]any) error {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || trimmed[0] != '{' {
		return fmt.Errorf("not an object")
	}
	return json.Unmarshal([]byte(trimmed), out)
}

// grepJSONString recovers one string value from a truncated payload by matching
// the literal `"key": "value"` spelling. The value ends at the closing quote of
// the first unescaped `"` — close enough for a one-line brief, and the only
// option when the JSON was cut in half on the wire.
func grepJSONString(text, key string) (string, bool) {
	needle := fmt.Sprintf("%q:", key)
	index := strings.Index(text, needle)
	if index < 0 {
		return "", false
	}
	rest := text[index+len(needle):]
	rest = strings.TrimLeft(rest, " ")
	if rest == "" || rest[0] != '"' {
		return "", false
	}
	var out strings.Builder
	for i := 1; i < len(rest); i++ {
		char := rest[i]
		if char == '\\' && i+1 < len(rest) {
			i++
			switch rest[i] {
			case 'n':
				out.WriteByte(' ')
			case 't':
				out.WriteByte(' ')
			case '"':
				out.WriteByte('"')
			case '\\':
				out.WriteByte('\\')
			default:
				out.WriteByte(rest[i])
			}
			continue
		}
		if char == '"' {
			return out.String(), true
		}
		out.WriteByte(char)
	}
	// Ran off the end: the payload was truncated mid-value. What survived is
	// still more useful than nothing.
	return out.String(), true
}
