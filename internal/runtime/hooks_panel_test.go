package runtime

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/hooks"
)

// The panel's tests go through `OpenRuntime` for the same reason the assembly tests do: a
// hand-built Runtime cannot tell "the panel reports what the session loaded" from "the
// panel reports what the file says", and that difference is the whole point of `state`.

// TestHooksPanelHelper is the hook process. The tests start this test binary as the script,
// so they depend on no interpreter and no checked-in script; the scenario travels in
// `TUDOUNI_HOOK_NAME`, the same way a real hook learns which hook it is.
func TestHooksPanelHelper(t *testing.T) {
	name := os.Getenv("TUDOUNI_HOOK_NAME")
	if !strings.HasPrefix(name, "panel-") {
		t.Skip("not a hook invocation")
	}
	switch strings.TrimPrefix(name, "panel-") {
	case "ok":
		os.Stdout.WriteString(`{"decision":"none"}`)
	case "deny":
		os.Stdout.WriteString(`{"decision":"deny","reason":"nope"}`)
	case "crash":
		os.Stderr.WriteString("boom: the script blew up")
		os.Exit(7)
	case "garbage":
		os.Stdout.WriteString("this is not json")
	}
	os.Exit(0)
}

// helperEntry is a pre_tool_use hook that runs this test binary in one scenario.
func helperEntry(scenario string) hooks.Entry {
	return hooks.Entry{
		Event:   "pre_tool_use",
		Name:    "panel-" + scenario,
		Argv:    []string{os.Args[0], "-test.run=TestHooksPanelHelper"},
		Enabled: true,
	}
}

// saveHooks writes the user's file through the same door the panel uses.
func saveHooks(t *testing.T, entries ...hooks.Entry) *hooks.File {
	t.Helper()
	current, err := hooks.ReadFile(HooksFile())
	if err != nil {
		t.Fatal(err)
	}
	saved, err := hooks.Save(HooksFile(), current.Revision, hooks.Document{Entries: entries})
	if err != nil {
		t.Fatalf("saving the fixture: %v", err)
	}
	return saved
}

func hooksPanelOf(t *testing.T, r *Runtime) map[string]any {
	t.Helper()
	panel, err := r.HooksPanel()
	if err != nil {
		t.Fatal(err)
	}
	return panel
}

func entryNamed(t *testing.T, panel map[string]any, name string) map[string]any {
	t.Helper()
	for _, item := range panel["entries"].([]any) {
		row := item.(map[string]any)
		if row["name"] == name {
			return row
		}
	}
	t.Fatalf("no entry named %q in %v", name, panel["entries"])
	return nil
}

// fire runs the session's pre_tool_use hooks once, as a tool call would.
func fire(t *testing.T, r *Runtime) hooks.Result {
	t.Helper()
	envelope := hooks.Base{
		SessionID: "ses_panel", Workspace: r.Workspace.Root(), Mode: hooks.ModeInteractive,
	}.Envelope(hooks.EventPreToolUse)
	envelope.Tool = &hooks.ToolPayload{Name: "shell", Input: map[string]any{"command": "ls"}, Risk: "low", CallID: "c1"}
	return r.Hooks.Fire(context.Background(), envelope)
}

func TestThePanelOfAMachineWithNoFileIsEmptyButComplete(t *testing.T) {
	scene := newSandbox(t)
	panel := hooksPanelOf(t, scene.open(t, false))

	file := panel["file"].(map[string]any)
	if file["exists"] != false || file["revision"] != "" || file["problem"] != "" {
		t.Fatalf("file = %v, want absent without a problem", file)
	}
	if len(panel["entries"].([]any)) != 0 {
		t.Fatal("a machine with no file has entries")
	}
	// The form needs the event table even when nothing is configured, or there is nothing
	// to add a first hook to.
	events := panel["events"].([]any)
	if len(events) != len(hooks.Events) {
		t.Fatalf("events = %d, want all %d", len(events), len(hooks.Events))
	}
	gate := events[2].(map[string]any)
	if gate["name"] != "pre_tool_use" || gate["gate"] != true || gate["default_timeout_ms"] != hooks.GateTimeoutMs {
		t.Fatalf("pre_tool_use = %v, want the gate's tighter default", gate)
	}
	if panel["disabled"] != false {
		t.Fatal("disabled without --no-hooks")
	}
}

func TestAHookTheSessionLoadedIsActiveAndReportsHowItsRunsEnd(t *testing.T) {
	scene := newSandbox(t)
	saveHooks(t, helperEntry("ok"), helperEntry("crash"))
	r := scene.open(t, false)

	row := entryNamed(t, hooksPanelOf(t, r), "panel-ok")
	if row["state"] != hookActive {
		t.Fatalf("state = %v, want active", row["state"])
	}
	// Nothing has run yet, and that is a statement of its own: no `last`, zero runs.
	activity := row["activity"].(map[string]any)
	if activity["runs"] != 0 || activity["last"] != nil {
		t.Fatalf("activity before any run = %v", activity)
	}

	fire(t, r)

	panel := hooksPanelOf(t, r)
	ok := entryNamed(t, panel, "panel-ok")["activity"].(map[string]any)
	if ok["runs"] != 1 || ok["failures"] != 0 {
		t.Fatalf("ok activity = %v", ok)
	}
	last := ok["last"].(map[string]any)
	if last["class"] != hooks.ClassSuccess || last["status"] != hooks.StatusOK || last["exit_code"] != 0 {
		t.Fatalf("a clean run was reported as %v", last)
	}

	crash := entryNamed(t, panel, "panel-crash")["activity"].(map[string]any)
	if crash["runs"] != 1 || crash["failures"] != 1 {
		t.Fatalf("crash activity = %v", crash)
	}
	crashed := crash["last"].(map[string]any)
	if crashed["class"] != hooks.ClassCrashed || crashed["exit_code"] != 7 {
		t.Fatalf("a crash was reported as %v, want class crashed with exit code 7", crashed)
	}
	if !strings.Contains(crashed["reason"].(string), "boom") {
		t.Fatalf("reason = %q, want the start of the script's stderr", crashed["reason"])
	}
}

func TestARefusalIsNotAFailureAndABadAnswerIs(t *testing.T) {
	scene := newSandbox(t)
	saveHooks(t, helperEntry("garbage"))
	r := scene.open(t, false)
	fire(t, r)
	garbage := entryNamed(t, hooksPanelOf(t, r), "panel-garbage")["activity"].(map[string]any)
	if garbage["failures"] != 1 || garbage["last"].(map[string]any)["class"] != hooks.ClassFailed {
		t.Fatalf("a script that printed nonsense was reported as %v", garbage)
	}

	// A fresh session with a hook that refuses: the guardrail doing its job.
	scene = newSandbox(t)
	saveHooks(t, helperEntry("deny"))
	r = scene.open(t, false)
	fire(t, r)
	denied := entryNamed(t, hooksPanelOf(t, r), "panel-deny")["activity"].(map[string]any)
	if denied["failures"] != 0 || denied["last"].(map[string]any)["class"] != hooks.ClassRefused {
		t.Fatalf("a refusal was reported as %v, want refused and no failure", denied)
	}
}

func TestSavingMakesAHookPendingNotActive(t *testing.T) {
	scene := newSandbox(t)
	saveHooks(t, helperEntry("ok"))
	r := scene.open(t, false)

	// Edit the file after the session has loaded it.
	edited := helperEntry("ok")
	edited.Matcher = "^shell$"
	added := helperEntry("deny")
	saveHooks(t, edited, added)

	panel := hooksPanelOf(t, r)
	if state := entryNamed(t, panel, "panel-ok")["state"]; state != hookPending {
		t.Fatalf("an edited hook is %v, want pending: this session still runs the old one", state)
	}
	if state := entryNamed(t, panel, "panel-deny")["state"]; state != hookPending {
		t.Fatalf("a new hook is %v, want pending", state)
	}
}

func TestAnEditedHookDoesNotInheritTheOldCommandsResult(t *testing.T) {
	scene := newSandbox(t)
	saveHooks(t, helperEntry("crash"))
	r := scene.open(t, false)
	fire(t, r)

	changed := helperEntry("crash")
	changed.Argv = append(changed.Argv, "-test.v")
	saveHooks(t, changed)

	row := entryNamed(t, hooksPanelOf(t, r), "panel-crash")
	if row["state"] != hookPending || row["activity"] != nil {
		t.Fatalf("row = state %v activity %v: a result recorded before the edit belongs to the old command", row["state"], row["activity"])
	}
}

func TestSwitchingAHookOffInTheFileLeavesItPendingUntilTheNextSession(t *testing.T) {
	scene := newSandbox(t)
	saveHooks(t, helperEntry("ok"))
	r := scene.open(t, false)

	off := helperEntry("ok")
	off.Enabled = false
	saveHooks(t, off)

	// This session still runs it, so "off" would be a lie.
	if state := entryNamed(t, hooksPanelOf(t, r), "panel-ok")["state"]; state != hookPending {
		t.Fatalf("state = %v, want pending", state)
	}
	// The next session does not.
	next := scene.open(t, false)
	if state := entryNamed(t, hooksPanelOf(t, next), "panel-ok")["state"]; state != hookOff {
		t.Fatalf("state in a new session = %v, want off", state)
	}
}

func TestNoHooksIsSaidPerHookAndOnThePanel(t *testing.T) {
	scene := newSandbox(t)
	off := helperEntry("deny")
	off.Enabled = false
	saveHooks(t, helperEntry("ok"), off)
	r := scene.open(t, true)

	panel := hooksPanelOf(t, r)
	if panel["disabled"] != true {
		t.Fatal("--no-hooks is not on the panel")
	}
	if state := entryNamed(t, panel, "panel-ok")["state"]; state != hookBypassed {
		t.Fatalf("an enabled hook in a --no-hooks session is %v, want bypassed", state)
	}
	if state := entryNamed(t, panel, "panel-deny")["state"]; state != hookOff {
		t.Fatalf("a disabled hook in a --no-hooks session is %v, want off", state)
	}
}

func TestABrokenFileIsReportedAndNeverOverwritten(t *testing.T) {
	scene := newSandbox(t)
	path := HooksFile()
	if err := os.MkdirAll(strings.TrimSuffix(path, "hooks.json"), 0o700); err != nil {
		t.Fatal(err)
	}
	broken := []byte(`{"version":1,"hooks":{"pre_tool_use":[{"name":"x"}]}}`)
	if err := os.WriteFile(path, broken, 0o600); err != nil {
		t.Fatal(err)
	}
	// A session cannot even start with this file (that is the start-up error), so the
	// panel is built from a runtime assembled before the file broke.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	r := scene.open(t, false)
	if err := os.WriteFile(path, broken, 0o600); err != nil {
		t.Fatal(err)
	}

	file := hooksPanelOf(t, r)["file"].(map[string]any)
	if file["problem"] == "" || file["exists"] != true {
		t.Fatalf("file = %v, want the problem named", file)
	}

	_, err := r.HooksAction(HooksActionSave, map[string]any{
		"revision": file["revision"],
		"document": map[string]any{"entries": []any{}},
	})
	if err == nil || !strings.Contains(err.Error(), "left untouched") {
		t.Fatalf("err = %v, want a refusal that says the file was left alone", err)
	}
	if raw, _ := os.ReadFile(path); string(raw) != string(broken) {
		t.Fatalf("the broken file was rewritten: %s", raw)
	}
}

func TestSaveThroughTheActionWritesTheFileAndRefusesAStaleRevision(t *testing.T) {
	scene := newSandbox(t)
	r := scene.open(t, false)

	document := map[string]any{"entries": []any{
		map[string]any{"event": "stop", "name": "verify", "command": `go test ./...`, "enabled": true},
	}}
	result, err := r.HooksAction(HooksActionSave, map[string]any{"revision": "", "document": document})
	if err != nil {
		t.Fatal(err)
	}
	if result["hooks"] != 1 {
		t.Fatalf("result = %v", result)
	}
	panel := hooksPanelOf(t, r)
	row := entryNamed(t, panel, "verify")
	if row["command"] != "go test ./..." || row["shell"] != false || row["state"] != hookPending {
		t.Fatalf("row = %v", row)
	}

	// The revision from before the save is stale now.
	_, err = r.HooksAction(HooksActionSave, map[string]any{"revision": "", "document": document})
	if err == nil || !strings.Contains(err.Error(), "changed on disk") {
		t.Fatalf("err = %v, want the stale-revision sentence", err)
	}

	// And a document start-up would refuse writes nothing.
	revision := panel["file"].(map[string]any)["revision"]
	before, _ := os.ReadFile(HooksFile())
	bad := map[string]any{"entries": []any{
		map[string]any{"event": "pre_tool_use", "name": "g", "matcher": "([", "command": "x", "enabled": true},
	}}
	if _, err := r.HooksAction(HooksActionSave, map[string]any{"revision": revision, "document": bad}); err == nil {
		t.Fatal("a matcher that does not compile was saved")
	}
	if after, _ := os.ReadFile(HooksFile()); string(after) != string(before) {
		t.Fatal("a refused save changed the file")
	}
}

func TestTheActionNeedsItsArgumentsAndKnowsItsVerbs(t *testing.T) {
	scene := newSandbox(t)
	r := scene.open(t, false)
	for label, arguments := range map[string]map[string]any{
		"no revision": {"document": map[string]any{"entries": []any{}}},
		"no document": {"revision": ""},
		"bad entries": {"revision": "", "document": map[string]any{"entries": "nope"}},
	} {
		if _, err := r.HooksAction(HooksActionSave, arguments); err == nil {
			t.Errorf("%s was accepted", label)
		}
	}
	if _, err := r.HooksAction("explode", nil); err == nil {
		t.Error("an unknown verb was accepted")
	}
}

func TestTheWorkspacesFileIsListedReadOnlyWithTheReasonItDoesNotRun(t *testing.T) {
	scene := newSandbox(t)
	scene.workspaceHooksFile(t)
	r := scene.open(t, false)

	section := hooksPanelOf(t, r)["workspace"].(map[string]any)
	if section["exists"] != true || section["trusted"] != false {
		t.Fatalf("section = %v, want an untrusted file that exists", section)
	}
	if !strings.Contains(section["trust_command"].(string), "--trust-workspace-hooks") {
		t.Fatalf("trust_command = %v", section["trust_command"])
	}
	rows := section["entries"].([]any)
	if len(rows) != 2 {
		t.Fatalf("entries = %v, want both hooks the file declares", rows)
	}
	for _, item := range rows {
		if item.(map[string]any)["effective"] != false {
			t.Fatalf("an untrusted workspace hook is marked effective: %v", item)
		}
	}

	// Trusted: the pre_tool_use hook runs, the `stop` one never can.
	store, err := hooks.LoadTrust(TrustFile())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Approve(scene.Workspace, WorkspaceHooksPath(), "test"); err != nil {
		t.Fatal(err)
	}
	r = scene.open(t, false)
	section = hooksPanelOf(t, r)["workspace"].(map[string]any)
	if section["trusted"] != true {
		t.Fatalf("section = %v, want trusted", section)
	}
	byEvent := map[string]map[string]any{}
	for _, item := range section["entries"].([]any) {
		row := item.(map[string]any)
		byEvent[row["event"].(string)] = row
	}
	if byEvent["pre_tool_use"]["effective"] != true {
		t.Errorf("a trusted pre_tool_use hook is not effective: %v", byEvent["pre_tool_use"])
	}
	if byEvent["stop"]["effective"] != false || byEvent["stop"]["allowed"] != false {
		t.Errorf("a workspace stop hook is %v, want not allowed and not effective", byEvent["stop"])
	}
}

func TestTheScriptsFolderIsOfferedWithASuggestedCommand(t *testing.T) {
	scene := newSandbox(t)
	dir := hooks.ScriptsDir(strings.TrimSuffix(strings.ReplaceAll(HooksFile(), `\`, "/"), "/hooks.json"))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir+"/guard.py", []byte("print()"), 0o600); err != nil {
		t.Fatal(err)
	}
	panel := hooksPanelOf(t, scene.open(t, false))
	scripts := panel["scripts"].([]any)
	if len(scripts) != 1 {
		t.Fatalf("scripts = %v", scripts)
	}
	script := scripts[0].(map[string]any)
	if script["name"] != "guard.py" || !strings.Contains(script["command"].(string), "guard.py") {
		t.Fatalf("script = %v", script)
	}
}
