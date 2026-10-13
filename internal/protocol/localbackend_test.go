package protocol

import (
	"testing"
	"time"
)

// TestLocalBackendStartsTheRealRuntime pins LocalBackend to the same
// behaviour Client.Start always had, now that the launch lives in a separate
// type: the real binary starts, speaks the protocol over its stdio, and its
// stderr is readable through Diagnostics rather than landing on this
// process's own stderr.
//
// This is the regression test for the refactor itself — Client.Start calling
// StartWithBackend(NewLocalBackend(arguments)) must still start the same
// child the same way client_stdio_test.go's tests already pin from Client's
// side; this one checks LocalBackend directly.
func TestLocalBackendStartsTheRealRuntime(t *testing.T) {
	hooks := &captureHooks{}
	client := NewClient(hooks)
	t.Cleanup(client.Kill)

	backend := NewLocalBackend([]string{"--session", "../escape"})
	if err := client.StartWithBackend(backend); err != nil {
		t.Fatalf("StartWithBackend: %v", err)
	}

	code := client.Wait(30 * time.Second)
	if code != 2 {
		t.Errorf("the runtime exited with %d, want 2 (its own start-up refusal)", code)
	}

	// RuntimeExited is read through its own mutex, which is what makes it safe
	// to check right after Wait returns — unlike hooks.messages, which the exit
	// goroutine can still be appending to at this instant (OnMessage is called
	// after close(c.done), not before), so this test deliberately does not
	// inspect hooks.messages for the exit notice the way the mirroring
	// Client-level test does; see RuntimeExited's own doc for the ok/stopped
	// contract this is checking.
	if exitCode, stopped, ok := client.RuntimeExited(); !ok || exitCode != code || stopped {
		t.Errorf("RuntimeExited() = (%d, stopped=%v, ok=%v), want (%d, false, true)",
			exitCode, stopped, ok, code)
	}

	// The refused start-up writes its reason to stderr; LocalBackend's stderr
	// pipe is what Diagnostics now reads instead of a bare drop, so the
	// reason should be visible here (and nowhere on this test binary's own
	// stderr, which the existing TestTheRuntimeChildCannotWriteToTheFrontEndsTerminal
	// already covers through Client.Start).
	if len(client.Diagnostics()) == 0 {
		t.Error("Diagnostics is empty; the runtime's start-up refusal should have reached stderr")
	}
}
