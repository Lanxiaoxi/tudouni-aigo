package cggraph

import (
	"strconv"
	"strings"
)

// Go signature arity.
//
// Ported from CodeGraph's `goSignatureParts` / `goSignatureArity`
// (src/resolution/callback-synthesizer.ts). Go requires an implementation's method
// signature to equal the interface's, and the parameter and result counts are what the
// stored signature text settles for certain — `Get(ctx, key, opts ...OpOption)` is no
// `Get(id types.ID) Peer`.
//
// The extractor stores a signature as the parameter list's text followed by the
// result's: `(ctx context.Context, a, b int) (int, error)`. Splitting that correctly
// needs bracket, string-literal and comment awareness, because a parameter type can
// contain any of them (`map[string]func() (int, error)`).

// goSignatureArity is "params/results", or false when the signature does not read.
func goSignatureArity(signature string) (string, bool) {
	params, results, ok := goSignatureParts(signature)
	if !ok {
		return "", false
	}
	return strconv.Itoa(len(params)) + "/" + strconv.Itoa(len(results)), true
}

// goSignatureParts splits a Go signature into its parameter and result lists.
//
// A grouped declaration (`a, b int`) counts as the number of items it names — two, not
// one — which is what `goListItems` gives by splitting on top-level commas.
func goSignatureParts(signature string) (params, results []string, ok bool) {
	sig := strings.TrimSpace(signature)
	if sig == "" || sig[0] != '(' {
		return nil, nil, false
	}
	params, end, ok := goListItems(sig, 0)
	if !ok {
		return nil, nil, false
	}
	rest := strings.TrimSpace(sig[end+1:])
	if rest == "" || rest[0] != '(' {
		// A single unparenthesized result (`error`, `*File`) or none at all.
		if rest == "" {
			return params, nil, true
		}
		return params, []string{rest}, true
	}
	results, resultEnd, ok := goListItems(rest, 0)
	if !ok {
		return nil, nil, false
	}
	if strings.TrimSpace(rest[resultEnd+1:]) != "" {
		return nil, nil, false
	}
	return params, results, true
}

// goListItems returns the top-level items of the bracketed list opening at text[open],
// and the offset where it closes.
//
// Nested brackets, string literals and comments are skipped whole. `(ctx
// context.Context, a, b int)` yields `ctx context.Context`, `a`, `b int`.
func goListItems(text string, open int) (items []string, end int, ok bool) {
	depth := 0
	var item []byte
	for i := open; i < len(text); i++ {
		c := text[i]

		// A comment runs to its end and contributes nothing but a separator.
		if c == '/' && i+1 < len(text) && (text[i+1] == '/' || text[i+1] == '*') {
			var stop int
			if text[i+1] == '/' {
				stop = strings.IndexByte(text[i:], '\n')
				if stop < 0 {
					return nil, 0, false
				}
			} else {
				stop = (func() int {
					if p := strings.Index(text[i+2:], "*/"); p >= 0 {
						return p + i + 2
					}
					return -1
				}())
				if stop < 0 {
					return nil, 0, false
				}
				stop++ // include the '*'
			}
			i = stop
			item = append(item, ' ')
			continue
		}

		// A string, raw string or rune literal is one item, brackets and all.
		if c == '"' || c == '`' || c == '\'' {
			j := i + 1
			for j < len(text) && text[j] != c {
				if c != '`' && text[j] == '\\' {
					j += 2
					continue
				}
				j++
			}
			if j >= len(text) {
				return nil, 0, false
			}
			item = append(item, text[i:j+1]...)
			i = j
			continue
		}

		switch c {
		case '(', '[', '{':
			depth++
			if depth == 1 {
				continue
			}
		case ')', ']', '}':
			depth--
			if depth == 0 {
				if trimmed := strings.TrimSpace(string(item)); trimmed != "" {
					items = append(items, trimmed)
				}
				return items, i, true
			}
		case ',':
			if depth == 1 {
				if trimmed := strings.TrimSpace(string(item)); trimmed != "" {
					items = append(items, trimmed)
				}
				item = item[:0]
				continue
			}
		}
		item = append(item, c)
	}
	return nil, 0, false
}
