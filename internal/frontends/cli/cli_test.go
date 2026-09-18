package cli

import (
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
)

// fakeRuntime is the smallest thing the REPL's routing needs. The tests here are
// about **where output goes**, so the runtime only has to answer the calls the
// commands make and record the turns it was asked for.
type fakeRuntime struct {
	turns  []string
	fields map[string]any
	stats  string
	todos  string
	jobs   string
}

func (f *fakeRuntime) SessionID() string          { return "test" }
func (f *fakeRuntime) Messages() []map[string]any { return nil }
func (f *fakeRuntime) InitFields() map[string]any {
	if f.fields == nil {
		return map[string]any{}
	}
	return f.fields
}
func (f *fakeRuntime) StateMessage(bool) map[string]any   { return map[string]any{} }
func (f *fakeRuntime) StatusMessage() map[string]any      { return map[string]any{} }
func (f *fakeRuntime) ToolsMessage() map[string]any       { return map[string]any{} }
func (f *fakeRuntime) ContextMessage() map[string]any     { return map[string]any{} }
func (f *fakeRuntime) SkillsMessage() map[string]any      { return map[string]any{} }
func (f *fakeRuntime) SessionSummaries() []map[string]any { return nil }
func (f *fakeRuntime) Compact() (map[string]any, error)   { return map[string]any{}, nil }
func (f *fakeRuntime) SetAutopilot(bool)                  {}
func (f *fakeRuntime) SetModel(string) (bool, string)     { return true, "ok" }
func (f *fakeRuntime) SetThinking(bool) (bool, string)    { return true, "ok" }
func (f *fakeRuntime) SetEffort(string) (bool, string)    { return true, "ok" }
func (f *fakeRuntime) ClearStop()                         {}
func (f *fakeRuntime) Close() error                       { return nil }
func (f *fakeRuntime) StatsLine() string                  { return f.stats }
func (f *fakeRuntime) ProgressLine() string               { return f.todos }
func (f *fakeRuntime) JobsProgressLine() string           { return f.jobs }
func (f *fakeRuntime) MCPMessage(string, []string) (map[string]any, []string) {
	return nil, nil
}
func (f *fakeRuntime) RunTurn(text string) (string, error) {
	f.turns = append(f.turns, text)
	return "answer to " + text, nil
}

var _ protocol.Runtime = (*fakeRuntime)(nil)

// TestAnUnknownSlashLineReachesTheModel is the previous generation's rule, and it
// is the opposite of what "unknown command" intuition suggests: a line starting
// with `/` that the REPL does not recognise is **input**, not a mistake to
// discard. A path, a regex or a typo all look like this, and losing something the
// user meant to say costs more than one wasted round trip on a typo.
func TestAnUnknownSlashLineReachesTheModel(t *testing.T) {
	fake := &fakeRuntime{}
	handled, leave, next := handleCommand(fake, "/stauts", &strings.Builder{})
	if handled {
		t.Error("an unknown slash line was reported as a known command")
	}
	if leave || next != "" {
		t.Error("an unknown slash line asked to leave or switch sessions")
	}
	if len(fake.turns) != 0 {
		t.Error("handleCommand ran a turn; the caller is supposed to do that")
	}
}

// TestKnownCommandsAreClaimed is the other half: a command the REPL knows must be
// claimed, or the caller would send `/status` to the model as a message.
func TestKnownCommandsAreClaimed(t *testing.T) {
	known := []string{
		"/help", "/new", "/resume", "/status", "/tools", "/context", "/compact",
		"/model", "/thinking", "/effort", "/autopilot", "/skills", "/audit", "/mcp",
		"/exit", "/quit",
	}
	for _, line := range known {
		handled, _, _ := handleCommand(&fakeRuntime{}, line, &strings.Builder{})
		if !handled {
			t.Errorf("%s was not claimed as a command", line)
		}
	}
}

// TestTheEmptyLineAndTheExitWordsLeave covers the documented way out. The previous
// generation's help text promised "an empty line, exit, or quit", and the symptom of
// losing it is subtle rather than loud: `exit` is sent to the model as a message,
// which costs a real round trip and answers a question nobody asked.
func TestTheEmptyLineAndTheExitWordsLeave(t *testing.T) {
	for _, word := range []string{"exit", "quit", "EXIT", "Quit", "  quit  "} {
		if !isExitWord(word) {
			t.Errorf("%q does not leave the session", word)
		}
	}
	for _, word := range []string{"exit now", "exiting", "/exit", "leave"} {
		if isExitWord(word) {
			t.Errorf("%q leaves the session but should not", word)
		}
	}
}

// TestThinkingWithNoArgumentReportsTheRealState is the "takes effect on the next
// request" contract seen from the other side.
//
// Printing a fixed "on" is worse than printing nothing: the user reads it as
// confirmation that the switch they just flipped is in force, and the request that
// follows says otherwise.
func TestThinkingWithNoArgumentReportsTheRealState(t *testing.T) {
	fake := &fakeRuntime{}
	fake.fields = map[string]any{"thinking": false, "effort": "max"}
	out := &strings.Builder{}
	handleCommand(fake, "/thinking", out)

	text := out.String()
	if !strings.Contains(text, i18n.T("thinking.off")) {
		t.Errorf("the report does not say thinking is off:\n%s", text)
	}
	// The level is reported even while thinking is off: "did I lose the level I
	// set" is the next question, and the answer is no.
	if !strings.Contains(text, "max") {
		t.Errorf("the report does not carry the remembered effort:\n%s", text)
	}
}

// TestEffortWithNoArgumentReportsTheCurrentLevelNotTheMenu pins the difference
// between a value and a list of values. Printing the available levels where the
// current one belongs reads as "the current effort is low / high / max".
func TestEffortWithNoArgumentReportsTheCurrentLevel(t *testing.T) {
	fake := &fakeRuntime{}
	fake.fields = map[string]any{
		"thinking":      true,
		"effort":        "high",
		"effort_levels": []any{"low", "high", "max"},
	}
	out := &strings.Builder{}
	handleCommand(fake, "/effort", out)

	text := out.String()
	if !strings.Contains(text, i18n.T("effort.current", "effort", "high")) {
		t.Errorf("the report does not name the current level:\n%s", text)
	}
	if !strings.Contains(text, "low / high / max") {
		t.Errorf("the report does not offer the alternatives:\n%s", text)
	}
}

// TestABadThinkingValueStillReportsTheState: after a rejected value the user needs
// to know what the setting actually is now, and the refusal alone does not say.
func TestABadThinkingValueStillReportsTheState(t *testing.T) {
	fake := &fakeRuntime{}
	fake.fields = map[string]any{"thinking": true, "effort": "high"}
	out := &strings.Builder{}
	handleCommand(fake, "/thinking maybe", out)

	text := out.String()
	if !strings.Contains(text, i18n.T("thinking.unknown", "rest", "maybe")) {
		t.Errorf("a bad value is not reported:\n%s", text)
	}
	if !strings.Contains(text, i18n.T("thinking.on")) {
		t.Errorf("the state is not re-printed after a bad value:\n%s", text)
	}
}

// TestMCPWithABadArgumentSaysSoAndStillLists: an unrecognised action must not be
// passed through as if it were one, and the list is the next thing the user needs.
func TestMCPWithABadArgumentSaysSoAndStillLists(t *testing.T) {
	fake := &fakeRuntime{}
	out := &strings.Builder{}
	handleCommand(fake, "/mcp frobnicate github", out)
	if !strings.Contains(out.String(), i18n.T("cmd.mcp.unknown", "rest", "frobnicate github")) {
		t.Errorf("a bad /mcp action is not reported:\n%s", out.String())
	}

	out.Reset()
	handleCommand(fake, "/mcp load", out)
	if !strings.Contains(out.String(), i18n.T("cmd.mcp.unknown", "rest", "load")) {
		t.Errorf("/mcp load with no name is not reported:\n%s", out.String())
	}
}
