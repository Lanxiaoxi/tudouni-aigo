package runtime

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/agent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/hooks"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// The runtime's hook tests are about **placement**: the two things this layer owns
// are when a session-scoped event fires and what happens to a turn whose prompt was
// refused. The executor is covered with real processes in internal/hooks, and the
// tool events in internal/agent.

// countingHooks is a runner that records every envelope and answers from one script.
//
// It answers `Has` for every event on purpose: what these tests ask is "did this
// call site fire", and a filter that said no would make the answer "nobody asked"
// rather than "the wiring is right".
type countingHooks struct {
	events []hooks.Envelope
	answer hooks.Result
	onFire func(hooks.Envelope) hooks.Result
}

func (c *countingHooks) Fire(_ context.Context, envelope hooks.Envelope) hooks.Result {
	c.events = append(c.events, envelope)
	if c.onFire != nil {
		return c.onFire(envelope)
	}
	return c.answer
}

func (c *countingHooks) Has(hooks.Event) bool                { return true }
func (c *countingHooks) SetEmit(func(record map[string]any)) {}
func (c *countingHooks) SetDebug(func(text string))          {}

// hookRuntime is a runtime with just enough of one to fire the hook layer.
//
// Built by hand rather than through `OpenRuntime` for the reason every other test in
// this package is: assembling one needs a model catalogue, a workspace and a network
// client, and none of those has anything to do with the question.
func hookRuntime(t *testing.T, runner hooks.Configurable) *Runtime {
	t.Helper()
	session := state.NewEmptySession("20260101-120000")
	if runner == nil {
		runner = &countingHooks{}
	}
	return &Runtime{
		SessionIDValue: session.SessionID,
		SessionValue:   session,
		Hooks:          runner,
		HookContext:    &hooks.Context{},
	}
}

func TestSessionStartInjectsIntoTheFirstRequestOnly(t *testing.T) {
	runner := &countingHooks{answer: hooks.Result{
		Parts: []hooks.Part{{Hook: "greet", Event: hooks.EventSessionStart, Text: "the repo uses pnpm"}},
	}}
	runtimeValue := hookRuntime(t, runner)

	runtimeValue.fireSessionStart("startup")
	if runtimeValue.HookContext.Empty() {
		t.Fatal("session_start injected nothing")
	}
	if !strings.Contains(runtimeValue.HookContext.Text(), "pnpm") {
		t.Fatalf("text = %q", runtimeValue.HookContext.Text())
	}
	// The turn ends: the note goes with it.
	runtimeValue.HookContext.ClearTurn()
	if !runtimeValue.HookContext.Empty() {
		t.Fatalf("the note survived its turn: %q", runtimeValue.HookContext.Text())
	}
}

func TestSessionStartNamesWhereTheSessionCameFrom(t *testing.T) {
	// `resume` and `startup` are the same event with different meanings, and a hook
	// that greets a new session has no other way to tell them apart.
	runner := &countingHooks{}
	runtimeValue := hookRuntime(t, runner)

	runtimeValue.fireSessionStart("resume")
	if len(runner.events) != 1 {
		t.Fatalf("envelopes = %d, want one", len(runner.events))
	}
	if runner.events[0].Source != "resume" {
		t.Fatalf("source = %q, want resume", runner.events[0].Source)
	}
	if runner.events[0].SessionID != runtimeValue.SessionIDValue {
		t.Fatalf("session = %q", runner.events[0].SessionID)
	}
}

func TestSessionEndFiresExactlyOncePerRuntime(t *testing.T) {
	// `CloseForSwitch` labels the close and then calls `Close`; a hook that writes a
	// session report must not write it twice.
	fired := 0
	runner := &countingHooks{onFire: func(envelope hooks.Envelope) hooks.Result {
		if envelope.Event == hooks.EventSessionEnd {
			fired++
		}
		return hooks.Result{}
	}}
	runtimeValue := hookRuntime(t, runner)

	if err := runtimeValue.CloseForSwitch(); err != nil {
		t.Fatal(err)
	}
	if err := runtimeValue.Close(); err != nil {
		t.Fatal(err)
	}
	if fired != 1 {
		t.Fatalf("session_end fired %d times, want exactly one", fired)
	}
}

func TestAPromptRefusalLeavesTheSessionUntouched(t *testing.T) {
	// The turn did not happen: nothing was appended, and the error names the hook. A
	// front end turns it into a notice; it is not an answer.
	runtimeValue := hookRuntime(t, &countingHooks{answer: hooks.Result{
		Decision: hooks.DecisionDeny,
		Reason:   "hook 拒绝：no。不要重试。",
		DeniedBy: "no-secrets",
	}})
	before := runtimeValue.SessionValue.MessageCount()

	err := runtimeValue.fireUserPromptSubmit("rm -rf /")
	if err == nil {
		t.Fatal("the prompt was not refused")
	}
	blocked, ok := err.(*hooks.PromptBlocked)
	if !ok {
		t.Fatalf("err = %T, want *hooks.PromptBlocked", err)
	}
	if blocked.Hook != "no-secrets" {
		t.Fatalf("hook = %q, want the refusing hook named", blocked.Hook)
	}
	if runtimeValue.SessionValue.MessageCount() != before {
		t.Fatal("a refused prompt wrote to the session")
	}
}

func TestAStopBlockInAnAutonomousRoundIsReportedAndIgnored(t *testing.T) {
	// The request is made — a hook's author has to be able to see that it fired — and
	// the answer is overruled: continuing a goal belongs to the driver, and two
	// sources of "continue" would disagree about the round budget.
	runtimeValue := hookRuntime(t, &countingHooks{answer: hooks.Result{
		Decision: hooks.DecisionDeny, Reason: "verify first", DeniedBy: "verify",
	}})

	if runtimeValue.stopHook(agent.StopNotice{StopReason: "answered", Autonomous: true}) {
		t.Fatal("an autonomous round was continued")
	}
	notices := runtimeValue.DrainHookNotices()
	if len(notices) != 1 {
		t.Fatalf("notices = %#v, want one line saying the block was ignored", notices)
	}
	if text, _ := notices[0]["text"].(string); !strings.Contains(text, "automatic") {
		t.Fatalf("notice = %q, want it to say why", text)
	}
}

func TestAStopBlockInAPersonsTurnContinuesIt(t *testing.T) {
	runtimeValue := hookRuntime(t, &countingHooks{answer: hooks.Result{
		Decision: hooks.DecisionDeny, Reason: "the tests fail", DeniedBy: "verify",
	}})

	if !runtimeValue.stopHook(agent.StopNotice{StopReason: "answered"}) {
		t.Fatal("the turn was not continued")
	}
	notices := runtimeValue.DrainHookNotices()
	if len(notices) != 1 {
		t.Fatalf("notices = %#v, want one line naming the hook", notices)
	}
	if text, _ := notices[0]["text"].(string); !strings.Contains(text, "verify") {
		t.Fatalf("notice = %q, want the hook named", text)
	}
	// Draining twice returns nothing: a line about a turn is drawn once.
	if again := runtimeValue.DrainHookNotices(); len(again) != 0 {
		t.Fatalf("the notice was drained twice: %#v", again)
	}
}

// --- configuration loading -------------------------------------------------

// withHome points the user config directory at a temporary one. `paths` reads the
// environment, so this is the seam every file-level test in this package uses.
func withHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	// `paths.HomeDir` asks the OS, which caches on some platforms; the override below
	// is what makes the answer deterministic on this one.
	t.Setenv(paths.EnvHome, "")
	return home
}

func TestAMissingHooksFileLoadsWithNoSet(t *testing.T) {
	home := withHome(t)
	if _, err := os.Stat(hooks.HooksFile(filepath.Join(home, paths.RuntimeDirName))); !os.IsNotExist(err) {
		t.Skip("this machine has a hooks file; the test only checks the absent case")
	}
	load, err := LoadHooks(false)
	if err != nil {
		t.Fatalf("a missing file must not be an error: %v", err)
	}
	if load.Set != nil {
		t.Fatalf("load.Set = %#v, want nil", load.Set)
	}
}

func TestABrokenHooksFileIsAStartupError(t *testing.T) {
	// The design's rule: silence here is the failure mode, because a guardrail that is
	// present and does nothing is indistinguishable from one that is absent.
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
	configDir := paths.UserConfigDir()
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "hooks.json"), []byte(`{"version":1,`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadHooks(false); err == nil {
		t.Fatal("a malformed file was accepted")
	}
}

func TestNoHooksSkipsTheFileEvenWhenItIsBroken(t *testing.T) {
	// The escape hatch has to work when the file is the thing that is broken: a
	// guardrail cannot be fixed with a tool call it is refusing.
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
	configDir := paths.UserConfigDir()
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "hooks.json"), []byte(`{"version":1,`), 0o600); err != nil {
		t.Fatal(err)
	}
	load, err := LoadHooks(true)
	if err != nil {
		t.Fatalf("--no-hooks still failed on the broken file: %v", err)
	}
	if load.Set != nil || !load.Disabled {
		t.Fatalf("load = %#v, want the disabled state", load)
	}
	if len(load.Notices) != 1 {
		t.Fatalf("notices = %#v, want the one line that says it was skipped", load.Notices)
	}
}

func TestAWorkspaceFileIsReportedAndNotLoaded(t *testing.T) {
	// A repository that ships `.tudouni/hooks.json` is a repository whose author
	// expects it to run. Leaving that to silence is the exact failure the mcp.json
	// notice already exists to prevent.
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
	workspace := t.TempDir()
	t.Chdir(workspace)
	if err := os.MkdirAll(paths.WorkspaceRuntimeDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	workspaceFile := filepath.Join(paths.WorkspaceRuntimeDir(), "hooks.json")
	if err := os.WriteFile(workspaceFile, []byte(`{"version":1,"hooks":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	load, err := LoadHooks(false)
	if err != nil {
		t.Fatal(err)
	}
	if load.Set != nil {
		t.Fatal("the workspace file was loaded")
	}
	joined := ""
	for _, item := range load.Notices {
		if text, _ := item["text"].(string); text != "" {
			joined += text
		}
	}
	if !strings.Contains(joined, workspaceFile) {
		t.Fatalf("notices = %q, want the workspace path named", joined)
	}
	if !strings.Contains(joined, "trust-workspace-hooks") {
		t.Fatalf("notices = %q, want the remedy named", joined)
	}
}

func TestAWorkspaceHookIsOnlyLoadedWhenItsHashIsTrusted(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
	workspace := t.TempDir()
	file := filepath.Join(workspace, "hooks.json")
	if err := os.WriteFile(file, []byte(`{"version":1,"hooks":{
		"pre_tool_use":[{"name":"guard","command":["sh"]}],
		"stop":[{"name":"loop","command":["sh"]}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	trustPath := filepath.Join(dir, "trust.json")

	// Untrusted: no set, and a notice that says why.
	set, notices, err := LoadWorkspaceHooks(trustPath, workspace, file)
	if err != nil {
		t.Fatal(err)
	}
	if set != nil {
		t.Fatal("an untrusted workspace file was loaded")
	}
	if len(notices) == 0 {
		t.Fatal("an untrusted workspace file said nothing at all")
	}

	// Trusted: loaded, restricted, and the event it may not have is gone.
	store, err := hooks.LoadTrust(trustPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Approve(workspace, file, "test"); err != nil {
		t.Fatal(err)
	}
	set, _, err = LoadWorkspaceHooks(trustPath, workspace, file)
	if err != nil {
		t.Fatal(err)
	}
	if set == nil {
		t.Fatal("a trusted workspace file was not loaded")
	}
	if set.Has(hooks.EventStop) {
		t.Fatal("a workspace hook kept an event it is not allowed")
	}
	if !set.Has(hooks.EventPreToolUse) {
		t.Fatal("the workspace's pre_tool_use hook was dropped")
	}
}

func TestAssembleHooksFoldsTheTrustedWorkspaceFileIn(t *testing.T) {
	// The regression this exists for: `LoadWorkspaceHooks` was written, tested, and
	// **never called from assembly** — so `--trust-workspace-hooks` recorded a hash
	// and the repository's guardrail still did not run. A unit test on the loader
	// passed throughout, which is why the assertion here is on the assembled set.
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)

	workspace := t.TempDir()
	t.Chdir(workspace)
	userFile := filepath.Join(paths.UserConfigDir(), "hooks.json")
	if err := os.MkdirAll(filepath.Dir(userFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(userFile, []byte(`{"version":1,"hooks":{
		"pre_tool_use":[{"name":"mine","command":["sh"]}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	workspaceFile := filepath.Join(paths.WorkspaceRuntimeDir(), "hooks.json")
	if err := os.MkdirAll(filepath.Dir(workspaceFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(workspaceFile, []byte(`{"version":1,"hooks":{
		"pre_tool_use":[{"name":"theirs","command":["sh"]}],
		"stop":[{"name":"loop","command":["sh"]}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	// Before approval: only the person's own hook, and the workspace file is not
	// silently merged in.
	load, err := assembleHooks(false, workspace)
	if err != nil {
		t.Fatal(err)
	}
	if load.Set == nil || load.Set.Len() != 1 {
		t.Fatalf("before approval the set has %d hooks, want the user's one", load.Set.Len())
	}

	// After approval: both, the person's first, and the `stop` hook still absent
	// because a workspace may not shape when a turn ends.
	store, err := hooks.LoadTrust(TrustFile())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Approve(workspace, workspaceFile, "test"); err != nil {
		t.Fatal(err)
	}
	load, err = assembleHooks(false, workspace)
	if err != nil {
		t.Fatal(err)
	}
	if load.Set == nil {
		t.Fatal("the trusted workspace file was not loaded")
	}
	list := load.Set.Hooks(hooks.EventPreToolUse)
	if len(list) != 2 {
		t.Fatalf("pre_tool_use hooks = %d, want both files'", len(list))
	}
	if list[0].Source != hooks.SourceUser || list[1].Source != hooks.SourceWorkspace {
		t.Fatalf("order = %s then %s, want the user's first", list[0].Source, list[1].Source)
	}
	if load.Set.Has(hooks.EventStop) {
		t.Fatal("the workspace's stop hook was loaded")
	}
}

func TestNoHooksSkipsTheWorkspaceFileToo(t *testing.T) {
	// A switch that still loaded a repository's scripts would be a switch that only
	// half works — and the half it left on is the one nobody asked for.
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
	workspace := t.TempDir()
	t.Chdir(workspace)
	workspaceFile := filepath.Join(paths.WorkspaceRuntimeDir(), "hooks.json")
	if err := os.MkdirAll(filepath.Dir(workspaceFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(workspaceFile, []byte(`{"version":1,"hooks":{
		"pre_tool_use":[{"name":"guard","command":["sh"]}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := hooks.LoadTrust(TrustFile())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Approve(workspace, workspaceFile, "test"); err != nil {
		t.Fatal(err)
	}

	load, err := assembleHooks(true, workspace)
	if err != nil {
		t.Fatal(err)
	}
	if load.Set != nil {
		t.Fatalf("--no-hooks still loaded %d hooks", load.Set.Len())
	}
	if !load.Disabled {
		t.Fatal("--no-hooks was not reported")
	}
}

func TestTheEnvelopeOfEveryRuntimeEventCarriesTheSession(t *testing.T) {
	// The envelope is stamped from the runtime, and the session id on it is what makes
	// a hook's report joinable to the audit line it belongs to.
	runner := &countingHooks{}
	runtimeValue := hookRuntime(t, runner)
	runtimeValue.fireSessionEnd("shutdown")

	if len(runner.events) != 1 {
		t.Fatalf("envelopes = %d, want one", len(runner.events))
	}
	envelope := runner.events[0]
	if envelope.SessionID != runtimeValue.SessionIDValue {
		t.Fatalf("session = %q", envelope.SessionID)
	}
	if envelope.Reason != "shutdown" {
		t.Fatalf("reason = %q, want shutdown", envelope.Reason)
	}
}
