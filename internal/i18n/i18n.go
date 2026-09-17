// Package i18n renders user-facing text.
//
// This build speaks English only. The language-switching machinery the previous
// generation carried is gone on purpose: one language means no negotiation, no
// per-language tables to keep in step, and no "the interface says one thing and
// the model says another".
//
// What did **not** go away is the split between UI text and content:
//
//   - UI text (panels, notices, status lines, protocol replies) comes from this
//     package and is English.
//   - Content (the system prompt, tool descriptions, whatever the model answers)
//     is Chinese and lives with the thing that owns it. It is not a translation
//     concern: changing the interface language must not change what the model is
//     told.
//
// Placeholders use the `{name}` form. Call sites pass alternating key/value
// pairs: T("activity.tool_call", "tool", name, "index", index).
package i18n

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

// Pair is one placeholder binding.
type Pair struct {
	Key   string
	Value any
}

var (
	mu       sync.Mutex
	reported = map[string]bool{}
	// Sink receives a line the first time an unknown key is used. It defaults
	// to swallowing the report, because a missing translation must never take
	// the program down; the caller wires it to stderr.
	Sink = func(string) {}
)

// ReportMissing points the missing-key sink at somewhere visible.
func ReportMissing(sink func(string)) {
	mu.Lock()
	defer mu.Unlock()
	if sink != nil {
		Sink = sink
	}
}

// MissingKeys returns the keys that were asked for but never found, sorted.
// It exists so a test can assert the table is complete without guessing.
func MissingKeys() []string {
	mu.Lock()
	defer mu.Unlock()
	out := make([]string, 0, len(reported))
	for key := range reported {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

// ResetMissingKeys clears the record, for tests.
func ResetMissingKeys() {
	mu.Lock()
	defer mu.Unlock()
	reported = map[string]bool{}
}

// T renders one key with the given placeholder bindings.
//
// An unknown key returns a marker that is impossible to mistake for real text
// and reports itself once. Silently returning the key, or an empty string, is
// how a missing translation turns into a blank button nobody notices.
func T(key string, kv ...any) string {
	template, ok := catalog[key]
	if !ok {
		noteMissing(key)
		return "⟪" + key + "⟫"
	}
	return fill(template, key, kv)
}

// Tn renders a pluralised key. It looks for `key + ".one"` when n == 1 and
// `key + ".other"` otherwise. Both forms must exist; a lone base key is a bug,
// because English would then say "1 items".
func Tn(key string, n int, kv ...any) string {
	suffix := ".other"
	if n == 1 {
		suffix = ".one"
	}
	form := key + suffix
	template, ok := catalog[form]
	if !ok {
		// Fall back to the base key only if it exists; otherwise report.
		if base, okBase := catalog[key]; okBase {
			template = base
			form = key
		} else {
			noteMissing(form)
			return "⟪" + form + "⟫"
		}
	}
	kv = append(kv, "n", n)
	return fill(template, form, kv)
}

// Has reports whether a key exists. Used by tests that check the table is whole.
func Has(key string) bool {
	_, ok := catalog[key]
	return ok
}

// Lookup returns a key's template without reporting a miss.
//
// It exists for the places that build a key out of a value they did not choose —
// `outcome.<event outcome>`, `rail.permission.<disposition>`, `stop.<stop reason>`.
// Those call sites have a real fallback (print the raw value), and T's
// unmissable marker is the wrong answer there: the raw value is searchable and
// the marker is not. Use T everywhere the key is a literal.
func Lookup(key string) (string, bool) {
	text, ok := catalog[key]
	return text, ok
}

// LookupOr returns the key's text, or fallback when the key is not in the table.
func LookupOr(key, fallback string) string {
	if text, ok := catalog[key]; ok {
		return text
	}
	return fallback
}

// Keys returns every key in the table, sorted.
func Keys() []string {
	out := make([]string, 0, len(catalog))
	for key := range catalog {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

func fill(template, key string, kv []any) string {
	if len(kv) == 0 {
		return template
	}
	if len(kv)%2 != 0 {
		noteMissing(key + " (odd placeholder bindings)")
		return template
	}
	pairs := make([]Pair, 0, len(kv)/2)
	for i := 0; i+1 < len(kv); i += 2 {
		name, ok := kv[i].(string)
		if !ok {
			noteMissing(key + " (placeholder name is not a string)")
			return template
		}
		pairs = append(pairs, Pair{Key: name, Value: kv[i+1]})
	}
	return render(template, pairs)
}

func render(template string, pairs []Pair) string {
	var b strings.Builder
	b.Grow(len(template) + 16)
	for i := 0; i < len(template); {
		if template[i] != '{' {
			b.WriteByte(template[i])
			i++
			continue
		}
		end := strings.IndexByte(template[i:], '}')
		if end < 0 {
			b.WriteString(template[i:])
			break
		}
		name := template[i+1 : i+end]
		value, ok := lookup(pairs, name)
		if !ok {
			// Leave it literal: a placeholder with no binding shows up in the
			// interface instead of vanishing.
			b.WriteString(template[i : i+end+1])
			i += end + 1
			continue
		}
		b.WriteString(formatValue(value))
		i += end + 1
	}
	return b.String()
}

func lookup(pairs []Pair, name string) (any, bool) {
	for _, p := range pairs {
		if p.Key == name {
			return p.Value, true
		}
	}
	return nil, false
}

func formatValue(v any) string {
	switch value := v.(type) {
	case string:
		return value
	case nil:
		return ""
	case float64:
		// Keep integral floats integral: 5.0 should read "5", not "5.000000".
		if value == float64(int64(value)) {
			return fmt.Sprintf("%d", int64(value))
		}
		return fmt.Sprintf("%g", value)
	default:
		return fmt.Sprintf("%v", value)
	}
}

func noteMissing(key string) {
	mu.Lock()
	first := !reported[key]
	reported[key] = true
	sink := Sink
	mu.Unlock()
	if first {
		sink("[i18n] no text for key " + key)
	}
}
