package cggraph

import "testing"

// Arity is the only signature fact Go's structural check trusts, so the parser is
// pinned against the shapes a real Go tree contains. These cases are adapted from the
// reference implementation's own examples.

func TestGoSignatureArity(t *testing.T) {
	cases := []struct {
		signature string
		want      string
		ok        bool
	}{
		{"() string", "0/1", true},
		{"(ctx context.Context, key string) (int, error)", "2/2", true},
		// A grouped declaration names two parameters, not one.
		{"(a, b int) error", "2/1", true},
		{"(ctx context.Context, keys ...string) (int, error)", "2/2", true},
		// No parenthesis around a single result.
		{"() error", "0/1", true},
		{"()", "0/0", true},
		// A nested parameter type keeps its own commas out of the split.
		{"(h map[string]func() (int, error)) bool", "1/1", true},
		{"(fn func(a, b int)) error", "1/1", true},
		// Not a signature at all.
		{"", "", false},
		{"error", "", false},
		{"(unclosed", "", false},
	}
	for _, c := range cases {
		got, ok := goSignatureArity(c.signature)
		if ok != c.ok {
			t.Errorf("%q: ok = %v, want %v", c.signature, ok, c.ok)
			continue
		}
		if ok && got != c.want {
			t.Errorf("%q: arity = %q, want %q", c.signature, got, c.want)
		}
	}
}

func TestGoListItemsSkipsStringsAndComments(t *testing.T) {
	// A comma inside a string literal must not split an item.
	items, _, ok := goListItems(`(s string, t ...interface{})`, 0)
	if !ok {
		t.Fatal("did not parse")
	}
	if len(items) != 2 {
		t.Fatalf("items = %v, want 2", items)
	}
}

func TestMethodSetCovers(t *testing.T) {
	have := map[string][]string{"Read": {"() (int, error)"}, "Close": {"() error"}}
	cases := []struct {
		want map[string][]string
		ok   bool
	}{
		{map[string][]string{"Read": nil, "Close": nil}, true},
		{map[string][]string{"Read": nil}, true},
		{map[string][]string{"Read": nil, "Close": nil, "Write": nil}, false},
		{map[string][]string{"Seek": nil}, false},
	}
	for _, c := range cases {
		if got := methodSetCovers(have, c.want); got != c.ok {
			t.Errorf("covers(%v) = %v, want %v", keysOf(c.want), got, c.ok)
		}
	}
}

// The arity check is what stops a two-parameter `Get` from satisfying a one-parameter
// interface method of the same name.
func TestAritiesFit(t *testing.T) {
	want := map[string]map[string]bool{"Get": {"2/2": true}}
	wantNames := map[string][]string{"Get": {"(ctx, key) (int, error)"}}

	// Same counts: fits.
	have := map[string]map[string]bool{"Get": {"2/2": true}}
	if !aritiesFit(have, want, wantNames) {
		t.Error("matching arity rejected")
	}
	// Different counts: rejected.
	have = map[string]map[string]bool{"Get": {"1/1": true}}
	if aritiesFit(have, want, wantNames) {
		t.Error("mismatched arity accepted")
	}
	// Unreadable on the implementer's side rules nothing out (the tri-state).
	have = map[string]map[string]bool{"Get": nil}
	if !aritiesFit(have, want, wantNames) {
		t.Error("unreadable arity should not reject")
	}
	// A name with no entry at all rules nothing out either.
	if !aritiesFit(map[string]map[string]bool{}, want, wantNames) {
		t.Error("absent arity should not reject")
	}
}

func keysOf(m map[string][]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
