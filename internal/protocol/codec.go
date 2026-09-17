package protocol

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// ProtocolError is raised when a line cannot be treated as a protocol message
// at all. It is a hard error only for the envelope version; every other
// unrecognised shape is skipped and counted.
type ProtocolError struct {
	Msg string
}

func (e *ProtocolError) Error() string { return e.Msg }

func protocolErrorf(format string, args ...any) *ProtocolError {
	return &ProtocolError{Msg: fmt.Sprintf(format, args...)}
}

// Encode turns a message into one protocol line.
//
// Chinese is written as-is. Escaping it would work, but it triples the size of
// every line and makes the log unreadable for no gain: the transport is UTF-8
// on both ends.
func Encode(msg map[string]any) (string, error) {
	var b strings.Builder
	encoder := json.NewEncoder(&b)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(msg); err != nil {
		return "", err
	}
	// json.Encoder appends exactly one newline, which is what the protocol
	// wants: one message per line, newline terminated.
	return b.String(), nil
}

// MustEncode is Encode for messages built entirely from JSON-safe values.
// A failure here means a programming error (a channel, a func, a NaN), not a
// runtime condition, so it panics rather than silently dropping a line.
func MustEncode(msg map[string]any) string {
	line, err := Encode(msg)
	if err != nil {
		panic(fmt.Sprintf("protocol: cannot encode message: %v", err))
	}
	return line
}

// Decode parses one line.
//
// An empty line decodes to an empty message rather than an error: blank lines
// happen (a stray newline on a pipe) and are not worth a diagnostic. Anything
// that parses but is not a JSON object is a protocol error.
func Decode(line string) (map[string]any, error) {
	trimmed := strings.TrimRight(line, "\r\n")
	if strings.TrimSpace(trimmed) == "" {
		return map[string]any{}, nil
	}
	var value any
	if err := json.Unmarshal([]byte(trimmed), &value); err != nil {
		return nil, protocolErrorf("not JSON: %v", err)
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, protocolErrorf("a protocol line must be a JSON object, got %T", value)
	}
	return object, nil
}

// CheckVersion verifies the envelope version.
//
// This is the only place the runtime hard-fails on a message. Everything else
// — an unknown `t`, an unknown `kind`, an unexpected field — is ignored and
// the loop keeps going, because the two ends upgrade on their own schedules and
// dying on an unfamiliar message is the least necessary compatibility loss
// there is.
//
// `direction` only appears in the diagnostic ("from the frontend" / "from the
// runtime"), so the same sentence makes sense on either side.
func CheckVersion(msg map[string]any, direction string) error {
	raw, present := msg[KeyVersion]
	if !present {
		return protocolErrorf("the message has no %q field (%s)", KeyVersion, direction)
	}
	version, ok := asInt(raw)
	if !ok {
		return protocolErrorf("the %q field must be an integer, got %T (%s)", KeyVersion, raw, direction)
	}
	if version != VERSION {
		return protocolErrorf("protocol version mismatch: this build speaks %d, the message says %d (%s)",
			VERSION, version, direction)
	}
	return nil
}

// TypeOf returns the message kind, or "" when there is none.
func TypeOf(msg map[string]any) string {
	if value, ok := msg[KeyType].(string); ok {
		return value
	}
	return ""
}

// LineReader reads protocol messages off a stream, skipping the ones that do
// not parse.
//
// Skipping rather than failing is deliberate: a half-written line can appear
// when the writer was killed mid-write, and one unreadable line must not take
// down the conversation. The count is kept so the loop can report it once at
// the end instead of shouting per line.
type LineReader struct {
	scanner   *bufio.Scanner
	Skipped   int
	direction string
	lastErr   error
}

// NewLineReader wraps a reader. The scanner buffer is grown well past the
// default 64KB because a single `session_load` line can carry megabytes: the
// session's messages are sent whole, and read_file does not paginate.
//
// `direction` only appears in diagnostics; pass DirectionFromFrontend or
// DirectionFromRuntime so a version mismatch says which end is out of step.
func NewLineReader(r io.Reader, direction string) *LineReader {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), maxLineBytes)
	return &LineReader{scanner: scanner, direction: direction}
}

// Directions used in diagnostics.
const (
	DirectionFromFrontend = "from the frontend"
	DirectionFromRuntime  = "from the runtime"
)

// maxLineBytes bounds one protocol line. It has to be generous: restoring a
// long session sends every message in a single line, and an 8MB file the agent
// read is one of them.
const maxLineBytes = 256 << 20

// Next returns the next message. ok is false at end of stream.
func (lr *LineReader) Next() (map[string]any, bool) {
	for lr.scanner.Scan() {
		line := lr.scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		msg, err := Decode(line)
		if err != nil {
			lr.Skipped++
			continue
		}
		if err := CheckVersion(msg, lr.direction); err != nil {
			// A version mismatch is the hard failure; surface it as the end of
			// the stream and let the caller decide.
			lr.lastErr = err
			return nil, false
		}
		return msg, true
	}
	if err := lr.scanner.Err(); err != nil {
		lr.lastErr = err
	}
	return nil, false
}

// Err returns the reason iteration stopped, if it was not a clean end of stream.
func (lr *LineReader) Err() error { return lr.lastErr }

// asInt accepts every JSON number shape. encoding/json decodes numbers into
// float64 by default, and a version that arrives as 1.0 is still version 1.
func asInt(value any) (int, bool) {
	switch number := value.(type) {
	case float64:
		if number != float64(int64(number)) {
			return 0, false
		}
		return int(number), true
	case int:
		return number, true
	case int64:
		return int(number), true
	case json.Number:
		parsed, err := number.Int64()
		if err != nil {
			return 0, false
		}
		return int(parsed), true
	default:
		return 0, false
	}
}

// Int reads an integer field, accepting the number shapes JSON produces.
func Int(msg map[string]any, key string) (int, bool) {
	raw, ok := msg[key]
	if !ok {
		return 0, false
	}
	return asInt(raw)
}

// String reads a string field.
func String(msg map[string]any, key string) (string, bool) {
	value, ok := msg[key].(string)
	return value, ok
}

// Bool reads a boolean field.
//
// Note what this does *not* do: it does not treat "false" or 1 as true. The
// two directions of a wrong guess are not symmetric — believing a switch is on
// when it is off means executing something nobody agreed to.
func Bool(msg map[string]any, key string) (bool, bool) {
	value, ok := msg[key].(bool)
	return value, ok
}

// Object reads a nested object field.
func Object(msg map[string]any, key string) (map[string]any, bool) {
	value, ok := msg[key].(map[string]any)
	return value, ok
}

// BoolOr reads a boolean field, falling back when it is absent or not a boolean.
//
// It is for interface preferences only. A protocol decision — "is autopilot on",
// "did the user allow this" — must use Bool and handle the absence, because
// guessing in that direction is how a switch nobody flipped looks flipped.
func BoolOr(msg map[string]any, key string, fallback bool) bool {
	value, ok := msg[key].(bool)
	if !ok {
		return fallback
	}
	return value
}

// Strings reads an array-of-strings field.
func Strings(msg map[string]any, key string) ([]string, bool) {
	raw, ok := msg[key].([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		text, ok := item.(string)
		if !ok {
			return nil, false
		}
		out = append(out, text)
	}
	return out, true
}
