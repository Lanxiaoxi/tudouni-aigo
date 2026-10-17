package runtime

import (
	"strings"
	"testing"
)

// mcpObject builds the shape `LoadMcpServers` hands to `parseMcpServers`: the
// outermost object has only `servers`, and each entry is a plain object.
func mcpObject(servers map[string]any) map[string]any {
	return map[string]any{"servers": servers}
}

// TestAutoLoadDefaultsToOff pins the default, because the default is the product
// decision rather than a zero value that happened to be convenient.
//
// A person who writes a server into mcp.json has said "this is available". They
// have not said "run it every time I open a session", and the two are different
// commitments: the second one starts a program on this machine, with this user's
// privileges, before the first turn. If the default ever flips, every existing
// config silently changes meaning.
func TestAutoLoadDefaultsToOff(t *testing.T) {
	specs, _, err := parseMcpServers(mcpObject(map[string]any{
		"codegraph": map[string]any{"command": "codegraph"},
	}), "mcp.json")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(specs) != 1 {
		t.Fatalf("got %d specs, want 1", len(specs))
	}
	if specs[0].AutoLoad {
		t.Error("a server that does not mention auto_load was started automatically")
	}
}

// TestAutoLoadIsReadFromTheFile is the other half: the field has to actually work,
// or the switch is documentation.
func TestAutoLoadIsReadFromTheFile(t *testing.T) {
	specs, _, err := parseMcpServers(mcpObject(map[string]any{
		"codegraph": map[string]any{"command": "codegraph", "auto_load": true},
	}), "mcp.json")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(specs) != 1 || !specs[0].AutoLoad {
		t.Fatalf("auto_load was not honoured: %+v", specs)
	}
}

// TestAnExplicitNullAutoLoadSaysNothing reads `null` as absent rather than as an
// error.
//
// A null is how a generated or hand-edited file says "no value here", and failing
// the whole server list over it would report a problem where the person's intent
// is clear. A *wrong type* is the opposite — see the test below.
func TestAnExplicitNullAutoLoadSaysNothing(t *testing.T) {
	specs, _, err := parseMcpServers(mcpObject(map[string]any{
		"codegraph": map[string]any{"command": "codegraph", "auto_load": nil},
	}), "mcp.json")
	if err != nil {
		t.Fatalf("an explicit null was refused: %v", err)
	}
	if len(specs) != 1 || specs[0].AutoLoad {
		t.Fatalf("null did not read as the default: %+v", specs)
	}
}

// TestAMisspelledAutoLoadIsRefusedNotIgnored is the reason the key list exists.
//
// Before it, an unknown key inside a server object was skipped in silence: the
// person wrote `autoload`, nothing was mounted, no line anywhere explained it, and
// the only available conclusion was "this feature does not work". One error naming
// the key and the known ones costs a minute; the silence cost an afternoon.
func TestAMisspelledAutoLoadIsRefusedNotIgnored(t *testing.T) {
	_, _, err := parseMcpServers(mcpObject(map[string]any{
		"codegraph": map[string]any{"command": "codegraph", "autoload": true},
	}), "mcp.json")
	if err == nil {
		t.Fatal("a misspelled key was accepted in silence")
	}
	if !strings.Contains(err.Error(), "autoload") {
		t.Errorf("the error does not name the offending key: %v", err)
	}
	if !strings.Contains(err.Error(), "auto_load") {
		t.Errorf("the error does not list the known keys, so it cannot be acted on: %v", err)
	}
}

// TestAutoLoadMustBeABool refuses `"true"` as a string.
//
// This field decides whether a program runs at start-up. Accepting the string
// would mean accepting it for some spellings and not others (`"true"`, `"True"`,
// `"yes"`), and a boundary that depends on spelling is not a boundary.
func TestAutoLoadMustBeABool(t *testing.T) {
	_, _, err := parseMcpServers(mcpObject(map[string]any{
		"codegraph": map[string]any{"command": "codegraph", "auto_load": "true"},
	}), "mcp.json")
	if err == nil {
		t.Fatal("the string \"true\" was accepted as a boolean")
	}
	if !strings.Contains(err.Error(), "auto_load") {
		t.Errorf("the error does not say which field is wrong: %v", err)
	}
}

// TestAServerThatCannotStartDoesNotStopTheSession is the fail-soft rule.
//
// An external program being missing is not a fault in this one. If a broken
// `auto_load` server could stop a session from opening, one bad line in mcp.json
// would leave a person unable to reach the interface that explains how to fix it.
func TestAServerThatCannotStartDoesNotStopTheSession(t *testing.T) {
	runtimeValue := &Runtime{mcpMounts: map[string]*mcpMount{}}
	specs := []McpServerSpec{{
		Name:     "ghost",
		Command:  "tudouni-test-no-such-binary-9f3a",
		AutoLoad: true,
	}}

	notes, failed, mounted := runtimeValue.mcpAutoMount(specs)
	if mounted != 0 {
		t.Fatalf("a server that cannot start was counted as mounted (%d)", mounted)
	}
	if len(notes) != 0 {
		t.Errorf("a failed server produced success notes: %v", notes)
	}
	if len(failed) == 0 {
		t.Fatal("a failed server produced no sentence at all, so nothing would be reported")
	}
	if len(runtimeValue.mcpMountsSnapshot()) != 0 {
		t.Error("a failed server was left in the mount table")
	}
}

// TestAutoLoadOffMeansOff is the counterpart: a server that did not ask to start
// is not attempted at all.
//
// The bogus command is the assertion — if the mount were attempted, the failure
// would show up in `failed`, so an empty `failed` proves nothing was launched.
func TestAutoLoadOffMeansOff(t *testing.T) {
	runtimeValue := &Runtime{mcpMounts: map[string]*mcpMount{}}
	specs := []McpServerSpec{{
		Name:    "ghost",
		Command: "tudouni-test-no-such-binary-9f3a",
	}}

	notes, failed, mounted := runtimeValue.mcpAutoMount(specs)
	if mounted != 0 || len(notes) != 0 || len(failed) != 0 {
		t.Fatalf("a server with auto_load off was touched: notes=%v failed=%v mounted=%d",
			notes, failed, mounted)
	}
}

// TestMountingInitialisesTheTableItself is a regression test for a panic the
// auto-mount path found in real use.
//
// The mount table used to be created by `MCPMessage` — which worked only while
// `/mcp load` was the single way to mount, because that path always runs after a
// protocol message. Start-up mounting runs **before** any message, so the write
// landed on a nil map. A nil-map write is a panic, not an error, and it took out
// the whole session rather than the one server.
//
// The assertion is deliberately about the table rather than about a successful
// mount: a server that fails to start returns before the write, so only the
// invariant "the table exists by the time mcpLoad can write" can be checked
// without a real subprocess — and that invariant is exactly what was missing.
func TestMountingInitialisesTheTableItself(t *testing.T) {
	var runtimeValue Runtime // no protocol message has run: this is the start-up shape

	runtimeValue.mcpLoad(McpServerSpec{
		Name:    "ghost",
		Command: "tudouni-test-no-such-binary-9f3a",
	})

	if runtimeValue.mcpMounts == nil {
		t.Fatal("mcpLoad left the mount table nil: the first server that does start would panic")
	}
}

// TestTheStartUpNoticeReportsWhatIsActuallyRunning pins all three wordings.
//
// The notice used to have one form, "none of them is mounted yet", and it was
// always true. With auto_load it can be false in two directions — claiming nothing
// runs while servers run, or claiming the list is exhausted while some still wait —
// and a person who reads only this line would act on either one.
func TestTheStartUpNoticeReportsWhatIsActuallyRunning(t *testing.T) {
	specs := []McpServerSpec{{Name: "alpha"}, {Name: "beta"}}

	none := mcpNotice(specs, 0)
	if !strings.Contains(none, "none of them is mounted yet") {
		t.Errorf("nothing mounted: %q", none)
	}

	all := mcpNotice(specs, 2)
	if strings.Contains(all, "none of them is mounted yet") {
		t.Errorf("everything mounted, but the line says nothing is: %q", all)
	}
	if !strings.Contains(all, "all of them came up") {
		t.Errorf("everything mounted: %q", all)
	}

	some := mcpNotice(specs, 1)
	if !strings.Contains(some, "the other 1 wait for /mcp load") {
		t.Errorf("one of two mounted: %q", some)
	}
	if !strings.Contains(some, "1 came up") {
		t.Errorf("one of two mounted, but the count is missing: %q", some)
	}

	if empty := mcpNotice(nil, 0); empty != "" {
		t.Errorf("no servers configured should say nothing, got %q", empty)
	}
}
