package audit

import (
	"fmt"
	"sort"
	"strings"
)

// FormatLine renders one audit record for `--audit`.
//
// One line per record, time-only stamps and a capped body, because the shape that
// matters for a log is "can I see many of them at once and compare" — a two-line
// record with a full timestamp makes a hundred-line turn unreadable, and the fields
// that answer a question are near the front.
//
// The rendering is defensive on purpose: a record may be missing `kind`, `ts` or
// `step` — a log can be copied, spliced or truncated — and a viewer that crashes on
// a bad line is worse than useless, because the bad line is exactly the one
// somebody is looking for. Missing fields print as `?` so the line still appears.
// Unknown fields are printed rather than dropped: an unrecognised key is the only
// clue to what a newer build recorded.
func FormatLine(record map[string]any) string {
	kind, _ := record["kind"].(string)
	if kind == "" {
		kind = "?"
	}
	stamp, _ := record["ts"].(string)
	// Time only: the date is the same for every line of a session.
	if len(stamp) >= 19 {
		stamp = stamp[11:]
	}
	if stamp == "" {
		stamp = "?"
	}
	step := "?"
	if value, ok := record["step"]; ok {
		step = fmt.Sprintf("%v", value)
	}

	keys := make([]string, 0, len(record))
	for key := range record {
		switch key {
		case "kind", "ts", "step", "session_id", "run_id":
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, fmt.Sprintf("%s=%s", key, renderValue(record[key])))
	}
	body := strings.Join(parts, " ")
	// Capped so one record cannot take over the screen. The cap is on runes, not
	// bytes, so a Chinese body is cut at the same visible place as an English one.
	if runes := []rune(body); len(runes) > auditBodyLimit {
		body = string(runes[:auditBodyLimit])
	}

	return fmt.Sprintf("%s %-13s step=%-3s %s", stamp, kind, step, body)
}

// auditBodyLimit caps one rendered record.
const auditBodyLimit = 100

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
