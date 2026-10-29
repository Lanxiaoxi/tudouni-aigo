package hooks

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The runner tests start **this test binary** as the hook process, and the helper
// below is what it runs. They do not depend on a shell, a Python install or a
// script checked into the repository: those would make the suite pass or fail
// depending on the machine, and the thing under test is the runner, not the
// interpreter.
//
// **The helper reads its scenario out of `TUDOUNI_HOOK_NAME`**, and that is not a
// convenience: the environment a hook receives is an allowlist, and `TUDOUNI_*` is
// part of it by design. Reaching into the allowlist from a test would mean the test
// proved a different list than the one that ships. The name travels the same way a
// real hook learns which of several hooks it is, so the mechanism is under test
// rather than beside it.
func TestHelperProcess(t *testing.T) {
	name := os.Getenv("TUDOUNI_HOOK_NAME")
	if !strings.HasPrefix(name, "helper-") {
		t.Skip("not a hook invocation")
	}
	mode := strings.TrimPrefix(name, "helper-")
	switch mode {
	case "allow":
		os.Stdout.WriteString(`{"decision":"allow","reason":"fine"}`)
	case "deny":
		os.Stdout.WriteString(`{"decision":"deny","reason":"no secrets in the shell"}`)
	case "ask":
		os.Stdout.WriteString(`{"decision":"ask","reason":"check with me"}`)
	case "context":
		os.Stdout.WriteString(`{"additional_context":"This repository uses pnpm."}`)
	case "rewrite":
		os.Stdout.WriteString(`{"updated_input":{"command":"git status --short"}}`)
	case "silent":
		// No output at all: the "I only wanted a side effect" hook.
	case "badjson":
		os.Stdout.WriteString(`this is not json`)
	case "unknowndecision":
		os.Stdout.WriteString(`{"decision":"dey"}`)
	case "exit2":
		os.Stderr.WriteString("refusing: the command deletes the workspace")
		os.Exit(2)
	case "exit1":
		os.Stdout.WriteString(`{"decision":"allow"}`)
		os.Exit(1)
	case "sleep":
		time.Sleep(5 * time.Second)
	case "flood":
		// Past any configured ceiling, which must be reported as a failure rather
		// than parsed in half.
		chunk := strings.Repeat("x", 4096)
		for index := 0; index < 128; index++ {
			os.Stdout.WriteString(chunk)
		}
	case "echo-env":
		os.Stdout.WriteString(`{"decision":"none"}`)
		report := "event=" + os.Getenv("TUDOUNI_HOOK_EVENT") + "\n" +
			"name=" + name + "\n" +
			"workspace=" + os.Getenv("TUDOUNI_WORKSPACE") + "\n" +
			"session=" + os.Getenv("TUDOUNI_SESSION_ID") + "\n" +
			"mode=" + os.Getenv("TUDOUNI_MODE") + "\n" +
			"secret=" + os.Getenv("TUDOUNI_SECRET_CANARY") + "\n" +
			"cwd=" + mustCwd() + "\n" +
			"stdin=" + readStdin()
		os.WriteFile("hook-report.txt", []byte(report), 0o600)
	case "dump-stdin":
		os.Stdout.WriteString(`{"decision":"none"}`)
		os.WriteFile("hook-report.txt", []byte(readStdin()), 0o600)
	default:
		os.Exit(3)
	}
	os.Exit(0)
}

func mustCwd() string {
	dir, _ := os.Getwd()
	return dir
}

// readStdin reads **once and completely**, which is the contract a hook is given:
// one JSON object arrives on stdin and the descriptor then closes.
func readStdin() string {
	var builder strings.Builder
	buffer := make([]byte, 32*1024)
	for {
		count, err := os.Stdin.Read(buffer)
		if count > 0 {
			builder.Write(buffer[:count])
		}
		if err != nil {
			break
		}
	}
	return builder.String()
}

// newRunner compiles a one-hook set named after the scenario, running the helper.
//
// The name is `helper-<mode>` because that is how the helper learns its part; see
// TestHelperProcess.
func newRunner(t *testing.T, event Event, mode string, extra string) *Set {
	t.Helper()
	document := `{"version":1,"hooks":{"` + string(event) + `":[` +
		`{"name":"helper-` + mode + `","command":["` +
		strings.ReplaceAll(os.Args[0], `\`, `\\`) + `","-test.run=TestHelperProcess"]` +
		extra + `}]}}`
	set, err := Parse("hooks.json", []byte(document))
	if err != nil {
		t.Fatalf("building the runner: %v", err)
	}
	return set
}

// workspace is a temporary directory every invocation runs in: a hook's cwd is the
// workspace, and the helper writes its report there so the test can read it without
// needing an environment variable of its own.
func workspace(t *testing.T) string {
	t.Helper()
	return t.TempDir()
}

func toolEnvelope(event Event, workdir string) Envelope {
	envelope := Base{
		SessionID: "ses_test",
		Workspace: workdir,
		Cwd:       workdir,
		Mode:      ModeInteractive,
	}.Envelope(event)
	envelope.HookName = "helper-" + string(event)
	envelope.Tool = &ToolPayload{
		Name:   "shell",
		Input:  map[string]any{"command": "npm install"},
		Risk:   "high",
		CallID: "call_1",
	}
	return envelope
}

// --- decisions -------------------------------------------------------------

func TestTheThreeDecisionsComeBack(t *testing.T) {
	cases := map[string]Decision{
		"allow": DecisionAllow,
		"deny":  DecisionDeny,
		"ask":   DecisionAsk,
	}
	for mode, want := range cases {
		t.Run(mode, func(t *testing.T) {
			set := newRunner(t, EventPreToolUse, mode, "")
			result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
			if result.Decision != want {
				t.Fatalf("decision = %q, want %q", result.Decision, want)
			}
			wantStatus := StatusOK
			if want == DecisionDeny {
				// A refusal is a successful invocation: the hook ran, answered, and
				// the answer was no. `denied` says that; `ok` would say it agreed.
				wantStatus = StatusDenied
			}
			if len(result.Outcomes) != 1 || result.Outcomes[0].Status != wantStatus {
				t.Fatalf("outcomes = %#v, want one %s", result.Outcomes, wantStatus)
			}
		})
	}
}

func TestADenyCarriesTheHooksOwnWords(t *testing.T) {
	// The reason is the user's, and it is kept verbatim with one sentence around it:
	// rewriting it would be this program putting words in their mouth.
	set := newRunner(t, EventPreToolUse, "deny", "")
	result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
	if !strings.Contains(result.Reason, "no secrets in the shell") {
		t.Fatalf("reason = %q, want the hook's own sentence", result.Reason)
	}
	if !strings.Contains(result.Reason, "不要重试") {
		t.Fatalf("reason = %q, want the do-not-retry instruction", result.Reason)
	}
	if result.DeniedBy != "helper-deny" {
		t.Fatalf("denied_by = %q, want the hook's name", result.DeniedBy)
	}
}

func TestExitTwoIsARefusalWithStderrAsTheReason(t *testing.T) {
	set := newRunner(t, EventPreToolUse, "exit2", "")
	result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
	if result.Decision != DecisionDeny {
		t.Fatalf("decision = %q, want deny", result.Decision)
	}
	if !strings.Contains(result.Reason, "deletes the workspace") {
		t.Fatalf("reason = %q, want the stderr text", result.Reason)
	}
	if result.Outcomes[0].ExitCode == nil || *result.Outcomes[0].ExitCode != 2 {
		t.Fatalf("exit code = %v, want 2", result.Outcomes[0].ExitCode)
	}
}

func TestAnEmptyOutputIsNoOpinion(t *testing.T) {
	set := newRunner(t, EventPreToolUse, "silent", "")
	result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
	if result.Decision != DecisionNone {
		t.Fatalf("decision = %q, want none", result.Decision)
	}
	if result.Outcomes[0].Status != StatusOK {
		t.Fatalf("status = %q, want ok", result.Outcomes[0].Status)
	}
}

// --- failures --------------------------------------------------------------

func TestAGateFailsClosedAndAnObserverDoesNot(t *testing.T) {
	// The asymmetry, in one test: the same broken script is a refusal before a tool
	// call and a recorded no-op after it. A formatter that is broken must not be able
	// to stop a conversation, and a guardrail that is broken must not be able to
	// become transparent.
	for _, mode := range []string{"badjson", "exit1", "unknowndecision"} {
		t.Run(mode+"-gate", func(t *testing.T) {
			set := newRunner(t, EventPreToolUse, mode, "")
			result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
			if result.Decision != DecisionDeny || !result.Failed {
				t.Fatalf("decision = %q failed = %v, want a fail-closed refusal",
					result.Decision, result.Failed)
			}
			if !strings.Contains(result.Reason, "fail_closed") {
				t.Fatalf("reason = %q, want it to say which rule refused", result.Reason)
			}
		})
		t.Run(mode+"-observer", func(t *testing.T) {
			set := newRunner(t, EventPostToolUse, mode, "")
			result := set.Fire(context.Background(), toolEnvelope(EventPostToolUse, workspace(t)))
			if result.Decision != DecisionNone {
				t.Fatalf("decision = %q, want none (an observer fails open)", result.Decision)
			}
			if result.Outcomes[0].Status == StatusOK {
				t.Fatalf("status = %q, want the failure recorded", result.Outcomes[0].Status)
			}
		})
	}
}

func TestFailClosedCanBeTurnedOffOnAGate(t *testing.T) {
	// A configuration may say "this guardrail is advisory", and then a broken one is
	// recorded rather than obeyed.
	set := newRunner(t, EventPreToolUse, "badjson", `,"fail_closed":false`)
	result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
	if result.Decision != DecisionNone {
		t.Fatalf("decision = %q, want none", result.Decision)
	}
	if result.Outcomes[0].Status != StatusBadOutput {
		t.Fatalf("status = %q, want bad_output", result.Outcomes[0].Status)
	}
}

func TestATimeoutKillsTheHookAndSaysSo(t *testing.T) {
	if runtime.GOOS == "windows" && testing.Short() {
		t.Skip("spawning a helper that sleeps is slow on Windows under -short")
	}
	set := newRunner(t, EventPreToolUse, "sleep", `,"timeout_ms":300`)
	started := time.Now()
	result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
	elapsed := time.Since(started)
	if elapsed > 5*time.Second {
		t.Fatalf("the hook was given %s; the timeout did not fire", elapsed)
	}
	if result.Decision != DecisionDeny {
		t.Fatalf("decision = %q, want a fail-closed refusal", result.Decision)
	}
	if result.Outcomes[0].Status != StatusTimeout {
		t.Fatalf("status = %q, want timeout", result.Outcomes[0].Status)
	}
	if !strings.Contains(result.Reason, "超时") {
		t.Fatalf("reason = %q, want the model told which failure this was", result.Reason)
	}
}

func TestOutputPastTheLimitIsAFailureNotATruncation(t *testing.T) {
	// Half a JSON document parsed into half a decision is worse than no decision.
	set := newRunner(t, EventPreToolUse, "flood", `,"max_output_bytes":1024`)
	result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
	if result.Outcomes[0].Status != StatusTruncated {
		t.Fatalf("status = %q, want truncated", result.Outcomes[0].Status)
	}
	if result.Decision != DecisionDeny {
		t.Fatalf("decision = %q, want a fail-closed refusal", result.Decision)
	}
}

func TestAMissingExecutableIsASpawnError(t *testing.T) {
	set, err := Parse("hooks.json", []byte(`{"version":1,"hooks":{"pre_tool_use":[
		{"name":"gone","command":["definitely-not-a-real-program-xyz"]}]}}`))
	if err != nil {
		t.Fatal(err)
	}
	result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
	if result.Outcomes[0].Status != StatusSpawn {
		t.Fatalf("status = %q, want spawn_error", result.Outcomes[0].Status)
	}
	if result.Decision != DecisionDeny {
		t.Fatalf("decision = %q, want fail-closed", result.Decision)
	}
}

// --- aggregation -----------------------------------------------------------

func TestADenyShortCircuitsTheChain(t *testing.T) {
	// The rest must not run: a refused call that still costs three processes is both
	// wasteful and makes "why was this refused" depend on which hook ran last.
	exe := strings.ReplaceAll(os.Args[0], `\`, `\\`)
	document := `{"version":1,"hooks":{"pre_tool_use":[
		{"name":"helper-deny","command":["` + exe + `","-test.run=TestHelperProcess"]},
		{"name":"helper-allow","command":["` + exe + `","-test.run=TestHelperProcess"]}]}}`
	set, err := Parse("hooks.json", []byte(document))
	if err != nil {
		t.Fatal(err)
	}
	// The runner names each invocation after the hook it is running, so one shared
	// envelope is enough for two hooks with two names.
	result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
	if result.Decision != DecisionDeny {
		t.Fatalf("decision = %q, want deny", result.Decision)
	}
	if len(result.Outcomes) != 2 {
		t.Fatalf("outcomes = %d, want both hooks reported", len(result.Outcomes))
	}
	if result.Outcomes[1].Status != StatusSkipped {
		t.Fatalf("second hook status = %q, want skipped", result.Outcomes[1].Status)
	}
	if len(result.Skipped) != 1 || result.Skipped[0] != "helper-allow" {
		t.Fatalf("skipped = %v, want the second hook named", result.Skipped)
	}
}

func TestAskIsSticky(t *testing.T) {
	// Once a hook has asked for a person, a later `allow` must not turn that back
	// into an automatic release — that is how "I configured a check" quietly stops
	// checking.
	exe := strings.ReplaceAll(os.Args[0], `\`, `\\`)
	document := `{"version":1,"hooks":{"pre_tool_use":[
		{"name":"helper-ask","command":["` + exe + `","-test.run=TestHelperProcess"]},
		{"name":"helper-allow","command":["` + exe + `","-test.run=TestHelperProcess"]}]}}`
	set, err := Parse("hooks.json", []byte(document))
	if err != nil {
		t.Fatal(err)
	}
	result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
	if result.Decision != DecisionAsk {
		t.Fatalf("decision = %q, want ask", result.Decision)
	}
	if result.Ask != "helper-ask" {
		t.Fatalf("ask = %q, want the hook that asked named", result.Ask)
	}
}

func TestAMatcherKeepsAnUninterestedHookFromRunning(t *testing.T) {
	// The matcher is consulted before the process starts, so a hook that is not
	// interested costs nothing at all — and the audit shows no row for it, because no
	// invocation happened.
	set := newRunner(t, EventPreToolUse, "allow", `,"matcher":"read_file"`)
	envelope := toolEnvelope(EventPreToolUse, workspace(t))
	envelope.Tool.Name = "shell"
	result := set.Fire(context.Background(), envelope)
	if len(result.Outcomes) != 0 || result.Decision != DecisionNone {
		t.Fatalf("result = %#v, want nothing to have run", result)
	}
}

// --- rewrite and context ---------------------------------------------------

func TestARewriteComesBackAndMerges(t *testing.T) {
	set := newRunner(t, EventPreToolUse, "rewrite", "")
	result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
	if !result.Rewritten {
		t.Fatal("the rewrite was not reported")
	}
	if result.Updated["command"] != "git status --short" {
		t.Fatalf("updated = %#v", result.Updated)
	}
	// The risk and the call id are not part of the arguments and must not appear.
	if _, present := result.Updated["risk"]; present {
		t.Fatalf("updated = %#v, want only the arguments", result.Updated)
	}
	if !result.Outcomes[0].UpdatedInput {
		t.Fatal("the audit row does not say the input was rewritten")
	}
}

func TestContextComesBackAsParts(t *testing.T) {
	set := newRunner(t, EventPostToolUse, "context", "")
	result := set.Fire(context.Background(), toolEnvelope(EventPostToolUse, workspace(t)))
	if len(result.Parts) != 1 {
		t.Fatalf("parts = %#v, want one", result.Parts)
	}
	if result.Parts[0].Hook != "helper-context" || result.Parts[0].Event != EventPostToolUse {
		t.Fatalf("part = %#v, want the source kept", result.Parts[0])
	}
	if !strings.Contains(result.Context, "pnpm") {
		t.Fatalf("context = %q", result.Context)
	}
	if result.Outcomes[0].ContextChars == 0 {
		t.Fatal("the audit row does not record the injected length")
	}
}

// --- environment and cwd ---------------------------------------------------

func TestTheChildGetsTheAllowlistAndNothingElse(t *testing.T) {
	// The hook is the user's own code and may read whatever it likes; what it must
	// not be **handed** is the configuration, because that file holds API keys — and
	// an environment is the one channel that would leak them without the hook ever
	// asking.
	t.Setenv("TUDOUNI_SECRET_CANARY", "leak-me")
	workdir := workspace(t)

	set := newRunner(t, EventPreToolUse, "echo-env", "")
	envelope := toolEnvelope(EventPreToolUse, workdir)
	set.Fire(context.Background(), envelope)

	raw, err := os.ReadFile(filepath.Join(workdir, "hook-report.txt"))
	if err != nil {
		t.Fatalf("the hook wrote no report: %v", err)
	}
	report := string(raw)
	for _, want := range []string{
		"event=pre_tool_use",
		"name=helper-echo-env",
		"session=ses_test",
		"mode=interactive",
		"workspace=" + workdir,
		"cwd=" + workdir,
		"secret=\n",
	} {
		if !strings.Contains(report, want) {
			t.Errorf("report = %q, want %q", report, want)
		}
	}
	if strings.Contains(report, "leak-me") {
		t.Fatal("the environment carried a variable outside the allowlist")
	}
}

func TestStdinIsOneJSONObjectWithTheFieldsTheEventNeeds(t *testing.T) {
	// The helper writes back exactly what it was handed, so this is the shape check:
	// a hook receives **one** object, and the fields of the event are on it — flat,
	// beside the common ones.
	workdir := workspace(t)
	set := newRunner(t, EventPostToolUse, "dump-stdin", "")
	envelope := toolEnvelope(EventPostToolUse, workdir)
	envelope.Tool.Status = "ok"
	envelope.Tool.Result = "contents"
	envelope.Tool.DurationMs = 12
	set.Fire(context.Background(), envelope)

	raw, err := os.ReadFile(filepath.Join(workdir, "hook-report.txt"))
	if err != nil {
		t.Fatalf("the hook left no stdin report: %v", err)
	}
	seen := string(raw)
	for _, want := range []string{
		`"hook_event_name":"post_tool_use"`,
		`"tool_name":"shell"`,
		`"tool_status":"ok"`,
		`"tool_call_id":"call_1"`,
		`"duration_ms":12`,
	} {
		if !strings.Contains(seen, want) {
			t.Errorf("stdin = %q, want %q", seen, want)
		}
	}
	// One object, and only one: a trailing newline is fine, a second envelope is not.
	if strings.Count(seen, `"hook_event_name"`) != 1 {
		t.Fatalf("stdin carried more than one envelope: %q", seen)
	}
}

// --- audit -----------------------------------------------------------------

func TestEveryInvocationWritesOneRowAndSkippedOnesAreNamed(t *testing.T) {
	exe := strings.ReplaceAll(os.Args[0], `\`, `\\`)
	document := `{"version":1,"hooks":{"pre_tool_use":[
		{"name":"helper-deny","command":["` + exe + `","-test.run=TestHelperProcess"]},
		{"name":"helper-allow","command":["` + exe + `","-test.run=TestHelperProcess"]}]}}`
	set, err := Parse("hooks.json", []byte(document))
	if err != nil {
		t.Fatal(err)
	}
	var records []map[string]any
	set.SetEmit(func(record map[string]any) { records = append(records, record) })

	set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
	if len(records) != 2 {
		t.Fatalf("records = %d, want one per hook", len(records))
	}
	first, second := records[0], records[1]
	for key, want := range map[string]any{
		"kind": "hook_result", "event": "pre_tool_use", "hook": "helper-deny",
		"status": StatusDenied, "decision": "deny", "tool": "shell", "call_id": "call_1",
	} {
		if first[key] != want {
			t.Errorf("record[%q] = %v, want %v", key, first[key], want)
		}
	}
	if _, present := first["duration_ms"]; !present {
		t.Error("the record has no duration")
	}
	if second["status"] != StatusSkipped {
		t.Errorf("the skipped hook's status = %v", second["status"])
	}
	// The body never travels: the reason is a preview and there is no field carrying
	// the hook's whole answer.
	if body, present := first["stdout"]; present {
		t.Fatalf("the record carried the hook's output: %v", body)
	}
}

func TestANilSetFiresNothing(t *testing.T) {
	var set *Set
	if result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t))); result.Decision != "" {
		t.Fatalf("result = %#v, want the zero value", result)
	}
	if set.Has(EventPreToolUse) || set.Len() != 0 {
		t.Fatal("a nil set claimed to have hooks")
	}
}
