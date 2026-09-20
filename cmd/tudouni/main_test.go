package main

import "testing"

// TestWhichInterfaceABareInvocationGets pins the precedence of the interface flags.
//
// Every combination here is something a person can type, and one of them is a
// contradiction reached by accident (`--cli --tui`), so the behaviour has to be
// written down rather than left to the order of the branches in `run`. The terminal
// fact is a parameter for the same reason: a table is the only way to reach the
// branch that a test runner without a terminal can never get to.
func TestWhichInterfaceABareInvocationGets(t *testing.T) {
	cases := []struct {
		name     string
		opts     options
		terminal bool
		want     bool
	}{
		{"bare on a terminal", options{}, true, true},
		// The case the terminal check exists for: a redirected stdout has to get the
		// line REPL, not escape sequences.
		{"bare with a redirected stream", options{}, false, false},
		{"--cli", options{cli: true}, true, false},
		{"--cli with a redirected stream", options{cli: true}, false, false},
		{"--tui", options{tui: true}, true, true},
		// `--tui` means what it says: the terminal check rescues a bare invocation, it
		// does not overrule somebody who asked for the interface.
		{"--tui with a redirected stream", options{tui: true}, false, true},
		// A contradiction resolves toward the quieter interface, the way --no-stream
		// beats --stream.
		{"--cli beats --tui", options{tui: true, cli: true}, true, false},
		{"--runtime-stdio", options{stdio: true}, true, false},
		{"--cli --runtime-stdio", options{cli: true, stdio: true}, true, false},
		// Unchanged from before the default flipped: an explicit --tui still wins over
		// an explicit --runtime-stdio.
		{"--tui --runtime-stdio", options{tui: true, stdio: true}, true, true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := useFullScreen(test.opts, test.terminal); got != test.want {
				t.Errorf("useFullScreen(%+v, terminal=%v) = %v, want %v",
					test.opts, test.terminal, got, test.want)
			}
		})
	}
}
