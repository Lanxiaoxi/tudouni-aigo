package audit

import (
	"fmt"
	"sort"
	"strings"
)

// FormatLine renders one audit record for `--audit`.
//
// The rendering is defensive on purpose: a record may be missing `kind`, `ts` or
// `step` — a log can be copied, spliced or truncated — and a viewer that crashes on
// a bad line is worse than useless, because the bad line is exactly the one
// somebody is looking for. Unknown fields are printed rather than dropped: an
// unrecognised key is the only clue to what a newer build recorded.
func FormatLine(record map[string]any) string {
	kind, _ := record["kind"].(string)
	if kind == "" {
		kind = "(no kind)"
	}
	stamp, _ := record["ts"].(string)
	if stamp == "" {
		stamp = "(no time)"
	}
	step := "?"
	if value, ok := record["step"]; ok {
		step = fmt.Sprintf("%v", value)
	}
	session, _ := record["session_id"].(string)

	var extra []string
	keys := make([]string, 0, len(record))
	for key := range record {
		switch key {
		case "kind", "ts", "step", "session_id", "run_id":
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		extra = append(extra, fmt.Sprintf("%s=%s", key, renderValue(record[key])))
	}

	header := fmt.Sprintf("%s  step %s  %s", stamp, step, kind)
	if session != "" {
		header += "  session=" + session
	}
	if len(extra) == 0 {
		return header
	}
	return header + "\n    " + strings.Join(extra, "  ")
}

func renderValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return "-"
	case string:
		if strings.ContainsAny(typed, "\n") {
			return strings.ReplaceAll(typed, "\n", "\\n")
		}
		return typed
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			parts = append(parts, renderValue(item))
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, key := range keys {
			parts = append(parts, key+"="+renderValue(typed[key]))
		}
		return "{" + strings.Join(parts, ", ") + "}"
	default:
		return fmt.Sprintf("%v", typed)
	}
}
