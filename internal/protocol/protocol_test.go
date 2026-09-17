package protocol

import (
	"strings"
	"testing"
)

func TestEncodeDoesNotEscapeChinese(t *testing.T) {
	line, err := Encode(map[string]any{"t": "notice", "text": "中文原样写"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(line, "中文原样写") {
		t.Fatalf("the encoder escaped the text: %s", line)
	}
	if !strings.HasSuffix(line, "\n") {
		t.Fatal("a message must be newline terminated")
	}
}

func TestDecodeRejectsNonObjects(t *testing.T) {
	if _, err := Decode("[1,2,3]"); err == nil {
		t.Fatal("an array is not a protocol message")
	}
	if _, err := Decode("{not json"); err == nil {
		t.Fatal("malformed JSON must be reported")
	}
	message, err := Decode("   \n")
	if err != nil {
		t.Fatalf("a blank line is not an error: %v", err)
	}
	if len(message) != 0 {
		t.Fatalf("a blank line decodes to nothing, got %v", message)
	}
}

func TestVersionMismatchIsTheOnlyHardFailure(t *testing.T) {
	if err := CheckVersion(map[string]any{"v": float64(VERSION)}, "test"); err != nil {
		t.Fatalf("the current version must pass: %v", err)
	}
	if err := CheckVersion(map[string]any{"v": float64(VERSION + 1)}, "test"); err == nil {
		t.Fatal("a different envelope version must fail")
	}
	if err := CheckVersion(map[string]any{}, "test"); err == nil {
		t.Fatal("a missing version must fail")
	}
}

func TestUnknownMessageKindsAreIgnored(t *testing.T) {
	// The compatibility baseline: both ends upgrade on their own schedules, so an
	// unrecognised kind is skipped and the loop keeps going.
	server := NewServer(OpenStreams(strings.NewReader(""), &strings.Builder{}), Bootstrap{})
	if !server.Dispatch(map[string]any{"v": float64(VERSION), "t": "something_from_the_future"}) {
		t.Fatal("an unknown message kind must not stop the loop")
	}
}

func TestBoolDoesNotGuess(t *testing.T) {
	// Believing a switch is on when it is off is how something nobody agreed to
	// gets executed, so only a real boolean counts.
	if _, ok := Bool(map[string]any{"on": "false"}, "on"); ok {
		t.Fatal("a string is not a boolean")
	}
	if _, ok := Bool(map[string]any{"on": float64(1)}, "on"); ok {
		t.Fatal("a number is not a boolean")
	}
	if value, ok := Bool(map[string]any{"on": true}, "on"); !ok || !value {
		t.Fatal("a real boolean must read as one")
	}
}

func TestLineReaderSkipsUnreadableLines(t *testing.T) {
	input := strings.Join([]string{
		`{"v":1,"t":"status"}`,
		`half a line`,
		`{"v":1,"t":"interrupt"}`,
	}, "\n")
	reader := NewLineReader(strings.NewReader(input), DirectionFromFrontend)

	first, ok := reader.Next()
	if !ok || TypeOf(first) != InStatus {
		t.Fatalf("first message = %v", first)
	}
	second, ok := reader.Next()
	if !ok || TypeOf(second) != InInterrupt {
		t.Fatalf("second message = %v", second)
	}
	if reader.Skipped != 1 {
		t.Fatalf("skipped = %d, want 1", reader.Skipped)
	}
}
