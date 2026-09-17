package tui

import (
	"encoding/json"
	"strings"
)

// The quiet mode's one-line-per-call form needs to know what each call was
// *about*. The audit record only carries the first 200 characters of the
// arguments, so most large payloads do not parse — hence two paths: parse it when
// it is whole, and scrape the literal `"key": "value"` spelling when it is not.

// jsonUnmarshalObject parses a tool-arguments string into a map. Failure is
// normal: the wire copy of a tool call's arguments is truncated for the audit
// trail, so most large payloads simply will not parse.
func jsonUnmarshalObject(text string, out *map[string]any) error {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || trimmed[0] != '{' {
		return errNotAnObject
	}
	return json.Unmarshal([]byte(trimmed), out)
}

type notAnObjectError struct{}

func (notAnObjectError) Error() string { return "not an object" }

var errNotAnObject = notAnObjectError{}

// jsonStringPairs returns every top-level `"key": "value"` occurrence in order.
//
// The value ends at the first unescaped quote — close enough for a one-line
// brief, and the only option when the JSON was cut in half on the wire. It also
// decodes the standard escapes, so a value containing a quote comes back with the
// quote rather than with a backslash.
func jsonStringPairs(text string) [][2]string {
	var out [][2]string
	for index := 0; index < len(text); index++ {
		if text[index] != '"' {
			continue
		}
		key, next, ok := readJSONString(text, index)
		if !ok {
			index = next
			continue
		}
		rest := text[next:]
		colon := strings.IndexByte(rest, ':')
		if colon < 0 || strings.TrimSpace(rest[:colon]) != "" {
			index = next
			continue
		}
		rest = strings.TrimLeft(rest[colon+1:], " \t")
		if rest == "" || rest[0] != '"' {
			index = next
			continue
		}
		value, after, _ := readJSONString(rest, 0)
		out = append(out, [2]string{key, value})
		index = next + colon + 1 + after
	}
	return out
}

// readJSONString reads one quoted string starting at `start` and returns the
// decoded value plus the index just past the closing quote.
func readJSONString(text string, start int) (string, int, bool) {
	if start >= len(text) || text[start] != '"' {
		return "", start, false
	}
	var out strings.Builder
	for index := start + 1; index < len(text); index++ {
		char := text[index]
		if char == '\\' && index+1 < len(text) {
			index++
			switch text[index] {
			case 'n', 't', 'r':
				out.WriteByte(' ')
			case 'u':
				// \uXXXX: keep it simple — a brief is one line of context, and a
				// wrong decode is worse than an omitted escape.
				for skip := 0; skip < 4 && index+1 < len(text); skip++ {
					index++
				}
			default:
				out.WriteByte(text[index])
			}
			continue
		}
		if char == '"' {
			return out.String(), index + 1, true
		}
		out.WriteByte(char)
	}
	// Ran off the end: the payload was truncated mid-value. What survived is
	// still more useful than nothing.
	return out.String(), len(text), true
}
