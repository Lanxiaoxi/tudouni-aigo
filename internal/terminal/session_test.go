package terminal

import (
	"os"
	"strings"
	"testing"
)

// TestSplitRunesHoldsBackAnIncompleteCharacter is the test the coalescing policy
// exists for.
//
// A PTY delivers bytes, and a multi-byte character is split across two reads
// whenever the kernel fills its buffer in the middle of one. Emitting the halves
// separately puts a replacement character in the middle of a word — which for CJK
// text, box-drawing characters and emoji happens once every few thousand
// characters, looks like a memory bug, and cannot be fixed from a front end.
func TestSplitRunesHoldsBackAnIncompleteCharacter(t *testing.T) {
	// "中" is E4 B8 AD. A batch that ends after the first byte has to hand that
	// byte back rather than send it.
	complete, rest := splitRunes([]byte{'a', 0xE4})
	if string(complete) != "a" {
		t.Errorf("complete = %q, want %q", complete, "a")
	}
	if len(rest) != 1 || rest[0] != 0xE4 {
		t.Errorf("rest = % x, want the lone lead byte e4", rest)
	}

	// Two of the three bytes: still incomplete.
	complete, rest = splitRunes([]byte{'a', 0xE4, 0xB8})
	if string(complete) != "a" || len(rest) != 2 {
		t.Errorf("two-byte prefix: complete=%q rest=% x, want \"a\" and e4 b8", complete, rest)
	}

	// All three: complete, and nothing is held back.
	complete, rest = splitRunes([]byte{'a', 0xE4, 0xB8, 0xAD, 'b'})
	if string(complete) != "a中b" || len(rest) != 0 {
		t.Errorf("full rune: complete=%q rest=% x, want \"a中b\" and nothing", complete, rest)
	}
}

// TestSplitRunesEmitsAnInvalidByteRatherThanHoldingIt is the failure mode worth
// stating: holding a byte that can never be completed means waiting for a
// continuation character that is never coming, and the symptom is a terminal that
// has silently stopped producing output while its buffer grows.
func TestSplitRunesEmitsAnInvalidByteRatherThanHoldingIt(t *testing.T) {
	cases := [][]byte{
		{0xFF},                   // never a valid lead byte
		{0x80},                   // a continuation byte with nothing before it
		{0xE4, 'x'},              // a lead byte followed by something that cannot continue it
		{0xC0, 0x80},             // overlong encoding: invalid, and not a prefix of anything
		{0xF5, 0x80, 0x80, 0x80}, // beyond U+10FFFF
	}
	for _, input := range cases {
		complete, rest := splitRunes(input)
		if len(rest) != 0 {
			t.Errorf("splitRunes(% x) held back % x; an uncompletable byte must be emitted", input, rest)
		}
		if len(complete) != len(input) {
			t.Errorf("splitRunes(% x) returned %d bytes, want all %d", input, len(complete), len(input))
		}
	}
}

func TestSplitRunesPassesThroughValidAndEmpty(t *testing.T) {
	if complete, rest := splitRunes(nil); len(complete) != 0 || len(rest) != 0 {
		t.Errorf("splitRunes(nil) = %q, % x; want nothing", complete, rest)
	}
	// Plain ASCII — the common case — must not be copied or reordered: this runs
	// on every batch of every terminal's output.
	ascii := []byte("npm test\r\n")
	complete, rest := splitRunes(ascii)
	if string(complete) != string(ascii) || len(rest) != 0 {
		t.Errorf("splitRunes(ascii) = %q, % x", complete, rest)
	}
}

// TestIsPartialRuneIsAboutPrefixesOnly pins the distinction between "a prefix of
// a valid encoding" and "invalid", because the two want opposite handling and
// both look like "not valid UTF-8" from the outside.
func TestIsPartialRuneIsAboutPrefixesOnly(t *testing.T) {
	cases := map[string]bool{
		"":             false,
		"a":            false,
		"\xe4":         true, // 3-byte lead, 1 of 3
		"\xe4\xb8":     true, // 3-byte lead, 2 of 3
		"\xe4\xb8\xad": false,
		"\xe4x":        false, // 'x' cannot continue it
		"\x80":         false, // a continuation byte is not a lead
	}
	for input, want := range cases {
		if got := isPartialRune([]byte(input)); got != want {
			t.Errorf("isPartialRune(% x) = %v, want %v", input, got, want)
		}
	}
}

// TestInputQueueRefusesAnUnboundedBacklog is the bound that keeps a paste into a
// busy terminal from growing without limit.
//
// It refuses rather than drops, and that distinction is the point: dropped input
// is silently *changed* input, which for a terminal means a command that runs with
// the middle of it missing.
func TestInputQueueRefusesAnUnboundedBacklog(t *testing.T) {
	queue := newInputQueue()
	// Nothing drains this queue, so it fills up exactly as it would behind a
	// shell that is not reading.
	chunk := make([]byte, 64*1024)
	var refused bool
	for attempt := 0; attempt < 64; attempt++ {
		if err := queue.push(chunk); err != nil {
			refused = true
			break
		}
	}
	if !refused {
		t.Fatalf("the queue accepted %d bytes without a ceiling", 64*len(chunk))
	}
}

func TestInputQueuePreservesOrder(t *testing.T) {
	queue := newInputQueue()
	for _, piece := range []string{"one", "two", "three"} {
		if err := queue.push([]byte(piece)); err != nil {
			t.Fatalf("push(%q): %v", piece, err)
		}
	}
	// One writer, one reader: a terminal's input must never be reordered, because
	// reordered input is a command that ran with its characters shuffled.
	first, ok := queue.next()
	if !ok {
		t.Fatal("next reported nothing to write")
	}
	if string(first) != "onetwothree" {
		t.Errorf("batch = %q, want %q", first, "onetwothree")
	}
}

func TestInputQueueRefusesAfterClose(t *testing.T) {
	queue := newInputQueue()
	queue.close()
	if err := queue.push([]byte("x")); err == nil {
		t.Error("a closed queue accepted input")
	}
	if _, ok := queue.next(); ok {
		t.Error("a closed queue produced a batch")
	}
	// Closing twice is what a kill racing a shell that exited by itself looks
	// like, and it must not panic on a double close.
	queue.close()
}

func TestInputQueueCopiesTheCallersSlice(t *testing.T) {
	queue := newInputQueue()
	source := []byte("abc")
	if err := queue.push(source); err != nil {
		t.Fatalf("push: %v", err)
	}
	// The caller's slice belongs to a decoded protocol line this goroutine does
	// not own; holding the original would be a race the compiler cannot see.
	copy(source, "xyz")
	batch, _ := queue.next()
	if string(batch) != "abc" {
		t.Errorf("batch = %q, want %q (the queue must own its bytes)", batch, "abc")
	}
}

// TestEnvForForcesTheTerminalVariables is about the one thing a terminal must not
// inherit.
//
// Under a full-screen front end this process's own `TERM` describes *that*
// interface's terminal. A shell that inherited it would emit sequences for the
// wrong emulator, or believe it is attached to one when it is behind a PTY this
// program relays.
func TestEnvForForcesTheTerminalVariables(t *testing.T) {
	env := envFor(spawnSpec{Env: []string{"TERM=dumb", "COLORTERM=", "PATH=/usr/bin"}})
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "TERM=xterm-256color") {
		t.Errorf("TERM was not forced:\n%s", joined)
	}
	if strings.Contains(joined, "TERM=dumb") {
		t.Errorf("the inherited TERM survived:\n%s", joined)
	}
	if !strings.Contains(joined, "COLORTERM=truecolor") {
		t.Errorf("COLORTERM was not forced:\n%s", joined)
	}
	if !strings.Contains(joined, "PATH=/usr/bin") {
		t.Errorf("an unrelated variable was dropped:\n%s", joined)
	}
}

func TestEnvForLeavesUnrelatedNamesInAnExplicitEnvironmentAlone(t *testing.T) {
	// A caller that supplies an environment gets **that base**, not this process's
	// — which is what makes the function testable and what lets a caller ask for a
	// shell with no inherited PATH. The two forced names are still forced: which
	// names describe *this* terminal is a fact about the terminal, not about the
	// base it was started from.
	given := []string{"PATH=/only/this", "TERM=dumb"}
	env := envFor(spawnSpec{Env: given})
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "PATH=/only/this") {
		t.Errorf("the explicit PATH was dropped:\n%s", joined)
	}
	if strings.Contains(joined, "PATH="+os.Getenv("PATH")) && os.Getenv("PATH") != "/only/this" {
		t.Errorf("this process's PATH leaked into an explicit environment:\n%s", joined)
	}
	if !strings.Contains(joined, "TERM=xterm-256color") {
		t.Errorf("TERM was not forced over an explicit base:\n%s", joined)
	}
	if strings.Contains(joined, "TERM=dumb") {
		t.Errorf("the explicit TERM survived:\n%s", joined)
	}
}
