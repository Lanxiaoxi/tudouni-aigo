package ssh

import "testing"

// TestQuoteShellArgumentIsInertAgainstMetacharacters pins the one property
// DialRuntimeSession's caller (protocol.RemoteBackend) depends on: nothing
// recognisable as a shell operator survives being quoted, so a workspace path
// or a session id cannot change what the remote shell runs.
func TestQuoteShellArgumentIsInertAgainstMetacharacters(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"plain", "/opt/tudouni-aigo", "'/opt/tudouni-aigo'"},
		{"space", "a b", "'a b'"},
		{"semicolon injection", "a; rm -rf /", "'a; rm -rf /'"},
		{"dollar expansion", "$(whoami)", "'$(whoami)'"},
		{"backtick expansion", "`whoami`", "'`whoami`'"},
		{"single quote", "o'brien", "'o'\\''brien'"},
		{"empty", "", "''"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := QuoteShellArgument(tc.input); got != tc.want {
				t.Errorf("QuoteShellArgument(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}
