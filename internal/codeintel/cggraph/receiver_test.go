package cggraph

import "testing"

func TestParseParams(t *testing.T) {
	cases := []struct {
		line string
		want map[string]string
	}{
		{"func TestX(t *testing.T) {", map[string]string{"t": "T"}},
		{"func (s *Server) Run(ctx context.Context) error {", map[string]string{"s": "Server", "ctx": "Context"}},
		{"func helper(a int, t *testing.T) {", map[string]string{"a": "int", "t": "T"}},
		{"func f(m map[string]int, b *bytes.Buffer) {", map[string]string{"m": "int", "b": "Buffer"}},
		{"func noArgs() {", map[string]string{}},
		{"if err := do(); err != nil {", map[string]string{}},
	}
	for _, c := range cases {
		decls := parseDeclLine(c.line)
		got := map[string]string{}
		for _, d := range decls {
			got[d.Name] = d.TypeName
		}
		for name, want := range c.want {
			if got[name] != want {
				t.Errorf("%q: %s = %q, want %q (all: %v)", c.line, name, got[name], want, got)
			}
		}
	}
}

func TestReceiverTypeAt(t *testing.T) {
	decls := []localDecl{
		{Name: "err", TypeName: "", Line: 10},
		{Name: "t", TypeName: "T", Line: 5},
		{Name: "t", TypeName: "Timer", Line: 20},
	}
	if got := receiverTypeAt(decls, "t", 12); got != "T" {
		t.Errorf("at line 12: %q, want T", got)
	}
	if got := receiverTypeAt(decls, "t", 25); got != "Timer" {
		t.Errorf("at line 25: %q, want Timer (shadowing)", got)
	}
	if got := receiverTypeAt(decls, "err", 30); got != "" {
		t.Errorf("uninferable: %q, want empty", got)
	}
}

func TestSplitReceiverCall(t *testing.T) {
	cases := []struct {
		name         string
		recv, method string
		ok           bool
	}{
		{"t.Errorf", "t", "Errorf", true},
		{"err.Error", "err", "Error", true},
		{"a.b.Method", "", "", false},
		{"NoDot", "", "", false},
		{"fmt.Sprintf", "fmt", "Sprintf", true},
	}
	for _, c := range cases {
		recv, method, ok := splitReceiverCall(c.name)
		if recv != c.recv || method != c.method || ok != c.ok {
			t.Errorf("%q → (%q,%q,%v), want (%q,%q,%v)",
				c.name, recv, method, ok, c.recv, c.method, c.ok)
		}
	}
}

func TestOwnerTypeOf(t *testing.T) {
	cases := map[string]string{
		"RunCancelled::Error":  "RunCancelled",
		"internal::File.Close": "File",
		"pkg.Type.Method":      "Type",
		"Simple":               "",
	}
	for qn, want := range cases {
		if got := ownerTypeOf(qn); got != want {
			t.Errorf("ownerTypeOf(%q) = %q, want %q", qn, got, want)
		}
	}
}

func TestIsMethodOfType(t *testing.T) {
	cand := Candidate{Kind: "method", QualifiedName: "RunCancelled::Error"}
	if !isMethodOfType(&cand, "RunCancelled") {
		t.Error("Error on RunCancelled should match")
	}
	if isMethodOfType(&cand, "Other") {
		t.Error("Error on RunCancelled must not match Other")
	}
}
