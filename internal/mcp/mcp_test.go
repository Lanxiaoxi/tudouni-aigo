package mcp

import (
	"strings"
	"testing"
	"time"
)

// The parts worth pinning here are the ones where a mistake is silent: a tool name
// that collides and replaces another, a location that leaks a path or a token into
// the model's context, and a response shape the client refuses when a real server
// sends it.

// TestExposedNamesArePrefixedAndSanitised ...
//
// The prefix is what tells a person at an approval prompt that this is an outside
// tool, and the sanitising is what makes the name survive being written into a JSON
// schema.
func TestExposedNamesArePrefixedAndSanitised(t *testing.T) {
	cases := map[string]string{
		"echo":          "mcp__fake__echo",
		"count.lines":   "mcp__fake__count_lines",
		"read/file":     "mcp__fake__read_file",
		"with space":    "mcp__fake__with_space",
		"already_clean": "mcp__fake__already_clean",
	}
	for input, want := range cases {
		if got := ExposedName("fake", input); got != want {
			t.Errorf("%q became %q, want %q", input, got, want)
		}
	}
}

// TestLongNamesStayDistinct ...
//
// Truncating alone would make two long names from one server collide, and a
// collision means one of the tools silently disappears from the schema.
func TestLongNamesStayDistinct(t *testing.T) {
	long := strings.Repeat("a", 90)
	other := strings.Repeat("a", 89) + "b"

	first := ExposedName("server", long)
	second := ExposedName("server", other)

	if len(first) > ToolNameMax || len(second) > ToolNameMax {
		t.Fatalf("names exceed the limit: %d and %d", len(first), len(second))
	}
	if first == second {
		t.Fatalf("two long names collapsed into one: %q", first)
	}
	if !strings.HasPrefix(first, "mcp__server__") {
		t.Fatalf("the prefix was lost: %q", first)
	}
}

// TestALocalServerReportsNoLocation ...
//
// Its command line carries the paths it was started with, and this string reaches
// the model.
func TestALocalServerReportsNoLocation(t *testing.T) {
	local := ServerSpec{Name: "local", Command: "npx", Args: []string{"-y", "some-server"}}
	if where := local.Where(); where != "" {
		t.Fatalf("a local server reported its location: %q", where)
	}
}

// TestARemoteServerReportsOnlyTheHost ...
//
// Hosted endpoints routinely put a token in the path or the query, and this string
// is shown to the model and drawn on a screen.
func TestARemoteServerReportsOnlyTheHost(t *testing.T) {
	remote := ServerSpec{Name: "remote", URL: "https://mcp.example.com/api/v1?token=secret-value"}
	where := remote.Where()

	if !strings.HasPrefix(where, "https://mcp.example.com") {
		t.Fatalf("the host is missing: %q", where)
	}
	for _, leak := range []string{"token", "secret-value", "/api"} {
		if strings.Contains(where, leak) {
			t.Fatalf("the location leaked %q: %q", leak, where)
		}
	}
}

// TestContentBlocksBecomeText ...
//
// Dropping a non-text block would make a result that carried an image look like a
// result that carried nothing.
func TestContentBlocksBecomeText(t *testing.T) {
	text := renderContent([]any{
		map[string]any{"type": "text", "text": "第一段"},
		map[string]any{"type": "image", "mimeType": "image/png", "data": "AAAA"},
		map[string]any{"type": "text", "text": "第二段"},
	})

	if !strings.Contains(text, "第一段") || !strings.Contains(text, "第二段") {
		t.Fatalf("text blocks were lost: %q", text)
	}
	if !strings.Contains(text, "image/png") {
		t.Fatalf("the image block left no trace: %q", text)
	}
}

func TestAnEmptyContentListIsNotSilent(t *testing.T) {
	connection := NewConnection("fake", &stubChannel{}, 5)
	text, err := connection.CallTool("echo", map[string]any{"text": "x"})
	if err != nil {
		t.Fatalf("call failed: %v", err)
	}
	if strings.TrimSpace(text) == "" {
		t.Fatal("an empty result rendered as empty text; the model cannot tell that from a broken tool")
	}
}

// TestAnErrorFlagComesBackAsText ...
//
// That is the server's normal way of reporting a failed call, and the text is the
// explanation — returning an error instead would hide it from the model, which is
// the one reader it was written for.
func TestAnErrorFlagComesBackAsText(t *testing.T) {
	channel := &stubChannel{result: map[string]any{
		"isError": true,
		"content": []any{map[string]any{"type": "text", "text": "the server said no"}},
	}}
	connection := NewConnection("fake", channel, 5)

	text, err := connection.CallTool("echo", nil)
	if err != nil {
		t.Fatalf("an isError result was raised instead of returned: %v", err)
	}
	if !strings.Contains(text, "the server said no") {
		t.Fatalf("the explanation was lost: %q", text)
	}
}

// TestProtocolErrorsAreTyped ...
//
// The model can fix invalid arguments and cannot fix anything else, so the two have
// to be distinguishable by the caller.
func TestProtocolErrorsAreTyped(t *testing.T) {
	_, err := resultOrRaise(map[string]any{
		"error": map[string]any{"code": float64(-32602), "message": "missing field"},
	}, "tools/call")
	if _, ok := err.(McpToolError); !ok {
		t.Fatalf("invalid arguments came back as %T", err)
	}

	_, err = resultOrRaise(map[string]any{
		"error": map[string]any{"code": float64(-32601), "message": "no such method"},
	}, "tools/call")
	if _, ok := err.(McpError); !ok {
		t.Fatalf("a protocol error came back as %T", err)
	}

	// An error with no message still has to say something: an empty explanation
	// reads as "something went wrong for no reason".
	_, err = resultOrRaise(map[string]any{"error": map[string]any{"code": float64(-1)}}, "tools/list")
	if err == nil || !strings.Contains(err.Error(), "no explanation") {
		t.Fatalf("an empty error produced %v", err)
	}
}

// TestBothResponseShapesAreAccepted: servers choose between a JSON body and an
// event stream, and refusing either would make half of them unusable.
func TestBothResponseShapesAreAccepted(t *testing.T) {
	direct, err := decodeBody([]byte(`{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`), "application/json")
	if err != nil || direct["result"] == nil {
		t.Fatalf("a plain JSON body was refused: %v", err)
	}

	// The answer is the **last** data line: earlier ones are progress
	// notifications.
	stream := "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"first\":true}}\n\n" +
		"event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"last\":true}}\n\n"
	decoded, err := decodeBody([]byte(stream), "text/event-stream")
	if err != nil {
		t.Fatalf("an event stream was refused: %v", err)
	}
	result, _ := decoded["result"].(map[string]any)
	if _, present := result["last"]; !present {
		t.Fatalf("the wrong event was taken: %v", result)
	}

	if _, err := decodeBody([]byte("event: message\n\n"), "text/event-stream"); err == nil {
		t.Fatal("a stream with no data line was accepted")
	}
}

// TestServersWithoutAToolsCapabilityAreNotFailures ...
//
// "Connected with zero tools" and "did not connect" are two different facts, and
// reporting the second when the first is true sends somebody hunting for a
// connection problem that does not exist.
func TestServersWithoutAToolsCapabilityAreNotFailures(t *testing.T) {
	loaded := &Loaded{Spec: ServerSpec{Name: "bare"}}
	connection := NewConnection("bare", &stubChannel{}, 5)
	connection.capabilities = map[string]any{"logging": map[string]any{}}
	loaded.Connection = connection

	if connection.OffersTools() {
		t.Fatal("a server with no tools capability reported one")
	}
}

func TestServerNamesAreValidated(t *testing.T) {
	if !ValidateServerName("good-name_1") {
		t.Error("a valid name was refused")
	}
	for _, bad := range []string{"", "with space", "with/slash", strings.Repeat("a", 25), "点"} {
		if ValidateServerName(bad) {
			t.Errorf("%q was accepted", bad)
		}
	}
}

// stubChannel answers every request with the same result, so the calls above can be
// tested without a process or a network.
type stubChannel struct {
	result map[string]any
}

func (c *stubChannel) Request(method string, _ map[string]any, _ time.Duration) (map[string]any, error) {
	if c.result != nil {
		return c.result, nil
	}
	return map[string]any{}, nil
}

func (c *stubChannel) Close() error                        { return nil }
func (c *stubChannel) Where() string                       { return "" }
func (c *stubChannel) Notify(string, map[string]any) error { return nil }
