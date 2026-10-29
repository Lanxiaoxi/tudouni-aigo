package hooks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The config tests are about **refusing**, not about accepting. Every document in
// this file is one a person could plausibly write, and each of them fails in a way
// that would otherwise be silent: a misspelled key taking a default, a matcher that
// never matches, one event's name with a typo. A configuration that half-works is
// the failure this whole layer is written against.

func parse(t *testing.T, document string) (*Set, error) {
	t.Helper()
	return Parse("hooks.json", []byte(document))
}

func mustParse(t *testing.T, document string) *Set {
	t.Helper()
	set, err := parse(t, document)
	if err != nil {
		t.Fatalf("a valid document was refused: %v", err)
	}
	return set
}

func TestAMissingFileMeansNoHooks(t *testing.T) {
	set, err := Load(filepath.Join(t.TempDir(), "hooks.json"))
	if err != nil {
		t.Fatalf("a missing file must not be an error: %v", err)
	}
	if set != nil {
		t.Fatalf("a missing file produced a set with %d hooks", set.Len())
	}
}

func TestAnEmptyFileIsAnError(t *testing.T) {
	if _, err := parse(t, ""); err == nil {
		t.Fatal("an empty file was accepted")
	}
}

func TestVersionIsRequiredAndMustBeOne(t *testing.T) {
	if _, err := parse(t, `{"hooks":{}}`); err == nil {
		t.Fatal("a document without `version` was accepted")
	}
	if _, err := parse(t, `{"version":2,"hooks":{}}`); err == nil {
		t.Fatal("version 2 was accepted")
	}
	if _, err := parse(t, `{"version":"1","hooks":{}}`); err == nil {
		t.Fatal("a string version was accepted")
	}
}

func TestAnUnknownTopLevelKeyIsRefused(t *testing.T) {
	// `default` instead of `defaults` would otherwise be read as "no defaults",
	// and every hook would silently inherit the built-in timeout.
	_, err := parse(t, `{"version":1,"default":{"timeout_ms":9000}}`)
	if err == nil || !strings.Contains(err.Error(), "default") {
		t.Fatalf("err = %v, want a refusal naming the unknown key", err)
	}
}

func TestAnUnknownHookKeyIsRefused(t *testing.T) {
	// The design's example: `fail_close` must not quietly become the default.
	_, err := parse(t, `{"version":1,"hooks":{"stop":[{"name":"x","command":["sh"],"fail_close":true}]}}`)
	if err == nil || !strings.Contains(err.Error(), "fail_close") {
		t.Fatalf("err = %v, want a refusal naming `fail_close`", err)
	}
}

func TestAnUnknownEventIsRefused(t *testing.T) {
	_, err := parse(t, `{"version":1,"hooks":{"pre_tool_use_x":[{"name":"x","command":["sh"]}]}}`)
	if err == nil || !strings.Contains(err.Error(), "pre_tool_use_x") {
		t.Fatalf("err = %v, want a refusal naming the event", err)
	}
}

func TestADuplicateNameWithinOneEventIsRefused(t *testing.T) {
	// Two hooks with one name would put two rows with the same `hook` field in the
	// audit, and "which of the two timed out" would have no answer.
	_, err := parse(t, `{"version":1,"hooks":{"stop":[
		{"name":"x","command":["sh"]},{"name":"x","command":["sh"]}]}}`)
	if err == nil || !strings.Contains(err.Error(), "two hooks named") {
		t.Fatalf("err = %v, want a duplicate-name refusal", err)
	}
}

func TestTheSameNameOnDifferentEventsIsFine(t *testing.T) {
	// The name identifies one hook **within one event**: a person who writes `fmt`
	// on both pre and post is describing one intention in two places, and refusing
	// that would be refusing the natural spelling.
	set := mustParse(t, `{"version":1,"hooks":{
		"pre_tool_use":[{"name":"fmt","command":["sh"]}],
		"post_tool_use":[{"name":"fmt","command":["sh"]}]}}`)
	if set.Len() != 2 {
		t.Fatalf("hooks = %d, want 2", set.Len())
	}
}

func TestABadMatcherIsRefused(t *testing.T) {
	_, err := parse(t, `{"version":1,"hooks":{"pre_tool_use":[
		{"name":"x","command":["sh"],"matcher":"read_file("}]}}`)
	if err == nil {
		t.Fatal("an uncompilable matcher was accepted")
	}
}

func TestTimeoutBoundsAreEnforced(t *testing.T) {
	for _, document := range []string{
		`{"version":1,"hooks":{"stop":[{"name":"x","command":["sh"],"timeout_ms":0}]}}`,
		`{"version":1,"hooks":{"stop":[{"name":"x","command":["sh"],"timeout_ms":60001}]}}`,
		`{"version":1,"hooks":{"stop":[{"name":"x","command":["sh"],"timeout_ms":1.5}]}}`,
	} {
		if _, err := parse(t, document); err == nil {
			t.Fatalf("accepted: %s", document)
		}
	}
}

func TestCommandFormsBothLoad(t *testing.T) {
	set := mustParse(t, `{"version":1,"hooks":{
		"pre_tool_use":[{"name":"argv","command":["python3","a b.py"]}],
		"post_tool_use":[{"name":"shell","command":"node \"C:/tools/fmt.mjs\""}]}}`)
	argv := set.Hooks("pre_tool_use")[0]
	if len(argv.Argv) != 2 || argv.Argv[1] != "a b.py" {
		t.Fatalf("argv = %#v, want the two elements untouched", argv.Argv)
	}
	shell := set.Hooks("post_tool_use")[0]
	if len(shell.Argv) < 3 {
		t.Fatalf("a shell string produced %#v, want a shell invocation", shell.Argv)
	}
	// The original spelling is kept for `--hooks`: a person comparing the listing
	// to their file has to see their own text.
	if !strings.Contains(shell.Command, "fmt.mjs") {
		t.Fatalf("command = %q, want the source text", shell.Command)
	}
}

func TestFailClosedDefaultsToTheGateOnly(t *testing.T) {
	set := mustParse(t, `{"version":1,"hooks":{
		"pre_tool_use":[{"name":"gate","command":["sh"]}],
		"permission_request":[{"name":"ask","command":["sh"]}],
		"post_tool_use":[{"name":"observe","command":["sh"]}],
		"stop":[{"name":"stop","command":["sh"]}]}}`)
	for _, event := range []Event{EventPreToolUse, EventPermissionRequest} {
		if !set.Hooks(event)[0].FailClosed {
			t.Errorf("%s: fail_closed = false, want true", event)
		}
	}
	for _, event := range []Event{EventPostToolUse, EventStop} {
		if set.Hooks(event)[0].FailClosed {
			t.Errorf("%s: fail_closed = true, want false", event)
		}
	}
}

func TestGateHooksInheritTheTighterTimeout(t *testing.T) {
	// The file's default applies everywhere, but a gate hook falls back to the
	// gate's own tighter default — a guardrail on the hot path that inherits a
	// five-second budget is a guardrail that makes every tool call five seconds
	// slow when it is broken.
	set := mustParse(t, `{"version":1,"defaults":{"timeout_ms":9000},"hooks":{
		"pre_tool_use":[{"name":"gate","command":["sh"]}],
		"post_tool_use":[{"name":"observe","command":["sh"]}]}}`)
	if got := set.Hooks("pre_tool_use")[0].TimeoutMs; got != GateTimeoutMs {
		t.Errorf("gate timeout = %d, want %d", got, GateTimeoutMs)
	}
	if got := set.Hooks("post_tool_use")[0].TimeoutMs; got != 9000 {
		t.Errorf("observer timeout = %d, want the file's 9000", got)
	}
}

func TestAnExplicitGateTimeoutIsHonoured(t *testing.T) {
	// The tighter default is a default, not a cap: asking for more explicitly works.
	set := mustParse(t, `{"version":1,"hooks":{"pre_tool_use":[
		{"name":"gate","command":["sh"],"timeout_ms":8000}]}}`)
	if got := set.Hooks("pre_tool_use")[0].TimeoutMs; got != 8000 {
		t.Fatalf("timeout = %d, want the explicit 8000", got)
	}
}

func TestADisabledHookStaysInTheListButNeverFires(t *testing.T) {
	set := mustParse(t, `{"version":1,"hooks":{"stop":[
		{"name":"off","command":["sh"],"enabled":false},
		{"name":"on","command":["sh"]}]}}`)
	if set.Len() != 1 {
		t.Fatalf("enabled count = %d, want 1", set.Len())
	}
	if set.Has("stop") != true {
		t.Fatal("the event reported no hooks")
	}
	rows := set.Describe()
	if len(rows) != 2 || rows[0].Enabled {
		t.Fatalf("rows = %#v, want both listed with the first disabled", rows)
	}
}

func TestTooManyHooksOnOneEventIsRefused(t *testing.T) {
	// A configuration is allowed to be wrong; it is not allowed to turn every tool
	// call into forty processes.
	var builder strings.Builder
	builder.WriteString(`{"version":1,"hooks":{"pre_tool_use":[`)
	for index := 0; index <= MaxHooksPerEvent; index++ {
		if index > 0 {
			builder.WriteString(",")
		}
		builder.WriteString(`{"name":"h`)
		builder.WriteString(itoaTest(index))
		builder.WriteString(`","command":["sh"]}`)
	}
	builder.WriteString(`]}}`)
	if _, err := parse(t, builder.String()); err == nil {
		t.Fatal("an oversized list was accepted")
	}
}

func itoaTest(value int) string {
	if value < 10 {
		return string(rune('0' + value))
	}
	return string(rune('0'+value/10)) + string(rune('0'+value%10))
}

// --- matcher ---------------------------------------------------------------

func TestMatcherSemantics(t *testing.T) {
	set := mustParse(t, `{"version":1,"hooks":{
		"pre_tool_use":[
			{"name":"all","command":["sh"]},
			{"name":"exact","command":["sh"],"matcher":"read_file"},
			{"name":"union","command":["sh"],"matcher":"read_file|grep"},
			{"name":"prefix","command":["sh"],"matcher":"^write"}]}}`)
	cases := []struct {
		tool string
		want []string
	}{
		{"read_file", []string{"all", "exact", "union"}},
		{"grep", []string{"all", "union"}},
		{"write_file", []string{"all", "prefix"}},
		// Substring semantics would match here; exact-or-nothing does not.
		{"read", []string{"all"}},
	}
	for _, testCase := range cases {
		var got []string
		for _, hook := range set.Hooks("pre_tool_use") {
			if hook.matches(testCase.tool) {
				got = append(got, hook.Name)
			}
		}
		if strings.Join(got, ",") != strings.Join(testCase.want, ",") {
			t.Errorf("%s matched %v, want %v", testCase.tool, got, testCase.want)
		}
	}
}

func TestMatchingIsCaseSensitive(t *testing.T) {
	// RE2's default, and matching one implementation's case-insensitivity would be
	// inventing a rule nobody wrote down.
	hook := Hook{Matcher: mustCompile(t, "read_file"), MatcherSource: "read_file"}
	if hook.matches("READ_FILE") {
		t.Fatal("a case-different tool name matched")
	}
}

// --- output parsing --------------------------------------------------------

func TestEmptyOutputIsNoOpinion(t *testing.T) {
	output, err := ParseOutput(nil, EventPostToolUse)
	if err != nil {
		t.Fatal(err)
	}
	if output.Decision != DecisionNone {
		t.Fatalf("decision = %q, want none", output.Decision)
	}
}

func TestAnUnknownDecisionValueIsAnError(t *testing.T) {
	// The hardest failure in this feature to diagnose: a typo'd `deny` read as "no
	// opinion" is a guardrail that visibly exists and visibly does nothing.
	if _, err := ParseOutput([]byte(`{"decision":"dey"}`), EventPreToolUse); err == nil {
		t.Fatal("a misspelled decision was accepted")
	}
}

func TestBlockIsAnAliasForDeny(t *testing.T) {
	output, err := ParseOutput([]byte(`{"decision":"block","reason":"no"}`), EventPreToolUse)
	if err != nil {
		t.Fatal(err)
	}
	if output.Decision != DecisionDeny {
		t.Fatalf("decision = %q, want deny", output.Decision)
	}
}

func TestADenyWithoutAReasonIsAnError(t *testing.T) {
	if _, err := ParseOutput([]byte(`{"decision":"deny"}`), EventPreToolUse); err == nil {
		t.Fatal("a refusal with no reason was accepted")
	}
}

func TestTrailingTextAfterTheObjectIsAnError(t *testing.T) {
	// A script that printed a debug line and then its decision must not silently
	// lose the decision.
	if _, err := ParseOutput([]byte("{\"decision\":\"allow\"}\nnot json"), EventPreToolUse); err == nil {
		t.Fatal("a second document was accepted")
	}
}

func TestAnObserverEventCannotDecide(t *testing.T) {
	// Attaching `deny` to `post_tool_use` is a misunderstanding this design does not
	// implement; a silent `none` would leave its author believing it worked.
	if _, err := ParseOutput([]byte(`{"decision":"deny","reason":"x"}`), EventPostToolUse); err == nil {
		t.Fatal("post_tool_use accepted a decision")
	}
	// The alias arrives at the same check.
	if _, err := ParseOutput([]byte(`{"decision":"block"}`), EventSessionEnd); err == nil {
		t.Fatal("session_end accepted a block")
	}
}

func TestOnlyPreToolUseAcceptsUpdatedInput(t *testing.T) {
	if _, err := ParseOutput([]byte(`{"updated_input":{"a":1}}`), EventUserPromptSubmit); err == nil {
		t.Fatal("user_prompt_submit accepted updated_input")
	}
	output, err := ParseOutput([]byte(`{"updated_input":{"a":1}}`), EventPreToolUse)
	if err != nil {
		t.Fatal(err)
	}
	// JSON numbers decode as float64; the value is what matters, not the Go type.
	if !output.HasUpdated || output.UpdatedInput["a"] != float64(1) {
		t.Fatalf("output = %#v, want the rewrite", output)
	}
}

func TestContextGoesToTheEventsThatHaveATail(t *testing.T) {
	for _, event := range []Event{EventSessionStart, EventUserPromptSubmit, EventPostToolUse, EventPreCompact} {
		if _, err := ParseOutput([]byte(`{"additional_context":"x"}`), event); err != nil {
			t.Errorf("%s refused additional_context: %v", event, err)
		}
	}
	for _, event := range []Event{EventPreToolUse, EventStop, EventSessionEnd, EventSubagentStart} {
		if _, err := ParseOutput([]byte(`{"additional_context":"x"}`), event); err == nil {
			t.Errorf("%s accepted additional_context", event)
		}
	}
}

func TestUnknownOutputKeysAreIgnored(t *testing.T) {
	// Forward compatibility: a newer hook may emit a field this build has never
	// heard of, and refusing the whole answer over it would make upgrading the hook
	// a breaking change.
	output, err := ParseOutput([]byte(`{"decision":"allow","future":true}`), EventPreToolUse)
	if err != nil {
		t.Fatalf("an unknown key was refused: %v", err)
	}
	if output.Decision != DecisionAllow {
		t.Fatalf("decision = %q", output.Decision)
	}
}

// --- merging ---------------------------------------------------------------

func TestUpdatedInputMergeRules(t *testing.T) {
	base := map[string]any{
		"command": "npm install",
		"env":     map[string]any{"A": "1", "B": "2"},
		"timeout": 30,
		"flags":   []any{"--x"},
		"drop_me": "gone",
	}
	patch := map[string]any{
		"command": "pnpm install",
		"env":     map[string]any{"B": "3", "C": "4"},
		"flags":   []any{"--y"},
		"drop_me": nil,
	}
	merged := MergeArguments(base, patch)

	if merged["command"] != "pnpm install" {
		t.Errorf("scalar did not replace: %v", merged["command"])
	}
	env, _ := merged["env"].(map[string]any)
	if env["A"] != "1" || env["B"] != "3" || env["C"] != "4" {
		t.Errorf("nested object did not merge: %v", env)
	}
	flags, _ := merged["flags"].([]any)
	if len(flags) != 1 || flags[0] != "--y" {
		t.Errorf("array did not replace: %v", flags)
	}
	if _, present := merged["drop_me"]; present {
		t.Error("null did not delete the key")
	}
	// The caller's map is the model's own arguments: a merge that wrote into it
	// would change what the audit records as "what the model asked for".
	if base["command"] != "npm install" {
		t.Fatalf("the merge wrote into the caller's map: %v", base["command"])
	}
}

func TestMergeWithNoBaseStillWorks(t *testing.T) {
	merged := MergeArguments(nil, map[string]any{"a": 1})
	if merged["a"] != 1 {
		t.Fatalf("merged = %v", merged)
	}
}

// --- envelope --------------------------------------------------------------

func TestEnvelopeIsFlat(t *testing.T) {
	envelope := Base{SessionID: "ses_1", Workspace: "/w", Mode: ModeInteractive}.
		Envelope(EventPreToolUse)
	envelope.Step = 3
	envelope.RunID = "run-1"
	envelope.HookName = "no-secrets"
	envelope.Tool = &ToolPayload{
		Name: "shell", Input: map[string]any{"command": "ls"}, Risk: "high", CallID: "call_1",
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"hook_event_name", "session_id", "cwd", "workspace",
		"mode", "autopilot", "hook_name", "tool_name", "tool_input", "tool_risk", "tool_call_id"} {
		if _, present := object[key]; !present {
			t.Errorf("%q is missing from the envelope", key)
		}
	}
	if _, nested := object["tool"]; nested {
		t.Error("the tool payload was nested; the shape is flat on purpose")
	}
	// The mode is not duplicated as a boolean the caller has to keep in step.
	if object["autopilot"] != false {
		t.Errorf("autopilot = %v, want false for interactive", object["autopilot"])
	}
}

func TestEnvelopeTruncatesFieldsNotTheDocument(t *testing.T) {
	envelope := Base{SessionID: "s"}.Envelope(EventPostToolUse)
	envelope.Tool = &ToolPayload{
		Name: "read_file", Status: "ok",
		Result: strings.Repeat("x", InputToolResultBytes+100),
	}
	clipped, cut := envelope.clip()
	if !cut || !clipped.Tool.Truncated {
		t.Fatal("an oversized result was not marked truncated")
	}
	if len(clipped.Tool.Result) != InputToolResultBytes {
		t.Fatalf("result = %d bytes, want %d", len(clipped.Tool.Result), InputToolResultBytes)
	}
	// The document must still be valid JSON — that is the whole difference between
	// "the hook saw less" and "the hook got half a document".
	if _, err := json.Marshal(clipped); err != nil {
		t.Fatalf("the clipped envelope does not marshal: %v", err)
	}
}

func TestAutoPilotModeIsSpelledOut(t *testing.T) {
	envelope := Base{Mode: ModeFor(true)}.Envelope(EventStop)
	raw, _ := json.Marshal(envelope)
	if !strings.Contains(string(raw), `"mode":"autopilot"`) || !strings.Contains(string(raw), `"autopilot":true`) {
		t.Fatalf("envelope = %s", raw)
	}
}

// --- trust -----------------------------------------------------------------

func TestAWorkspaceHookOnlyEverTightens(t *testing.T) {
	set := mustParse(t, `{"version":1,"hooks":{
		"pre_tool_use":[{"name":"guard","command":["sh"]}],
		"stop":[{"name":"loop","command":["sh"]}]}}`)
	restricted := RestrictSet(set)
	if restricted.Has("stop") {
		t.Fatal("a workspace hook was kept on the stop event")
	}
	if !restricted.Has("pre_tool_use") {
		t.Fatal("the pre_tool_use hook was dropped")
	}

	// And what it may say is narrower still: allow, rewrite and injected context
	// are all removed, and the removal is reported rather than silent.
	result := Result{
		Decision:  DecisionAllow,
		Updated:   map[string]any{"a": 1},
		Rewritten: true,
		Context:   "do this",
		Outcomes:  []Outcome{{Hook: "guard", Status: StatusOK, Decision: DecisionAllow}},
	}
	restrictedResult, refused := Restrict(result, EventPreToolUse)
	if restrictedResult.Decision != DecisionNone {
		t.Errorf("decision = %q, want none", restrictedResult.Decision)
	}
	if restrictedResult.Rewritten || restrictedResult.Updated != nil {
		t.Error("a workspace hook rewrote the arguments")
	}
	if restrictedResult.Context != "" {
		t.Error("a workspace hook injected context")
	}
	joined := strings.Join(refused, ",")
	for _, want := range []string{"allow", "updated_input", "additional_context"} {
		if !strings.Contains(joined, want) {
			t.Errorf("refused = %v, want %q named", refused, want)
		}
	}
}

func TestAWorkspaceDenySurvives(t *testing.T) {
	// The two decisions a repository **may** make, and denying is the important one.
	result, _ := Restrict(Result{Decision: DecisionDeny, Reason: "no", DeniedBy: "guard"},
		EventPreToolUse)
	if result.Decision != DecisionDeny {
		t.Fatalf("decision = %q, want deny", result.Decision)
	}
	asked, _ := Restrict(Result{Decision: DecisionAsk, Reason: "check"}, EventPreToolUse)
	if asked.Decision != DecisionAsk {
		t.Fatalf("decision = %q, want ask", asked.Decision)
	}
}

func TestTrustIsByHashSoEditingRevokesIt(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "hooks.json")
	if err := os.WriteFile(file, []byte(`{"version":1,"hooks":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store := &TrustStore{Path: filepath.Join(dir, "trust.json"), Workspaces: map[string]TrustRecord{}}
	if _, err := store.Approve(dir, file, "test"); err != nil {
		t.Fatal(err)
	}
	trusted, _ := store.Trusted(dir, file)
	if !trusted {
		t.Fatal("the file was not trusted after approval")
	}
	if err := os.WriteFile(file, []byte(`{"version":1,"hooks":{"stop":[]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	trusted, _ = store.Trusted(dir, file)
	if trusted {
		t.Fatal("an edited file stayed trusted")
	}
}

// --- context ---------------------------------------------------------------

func TestContextLifetimesAreSeparate(t *testing.T) {
	context := &Context{}
	context.AddTurn("start", EventSessionStart, "the repo uses pnpm")
	if text := context.Text(); !strings.Contains(text, "the repo uses pnpm") {
		t.Fatalf("text = %q", text)
	}
	context.AddBatch("fmt", EventPostToolUse, "formatted 3 files")
	if text := context.Text(); !strings.Contains(text, "formatted 3 files") {
		t.Fatalf("text = %q", text)
	}

	// A new batch clears the batch's note and **keeps** the turn's.
	context.ClearBatch()
	text := context.Text()
	if strings.Contains(text, "formatted 3 files") {
		t.Fatalf("batch context survived its batch: %q", text)
	}
	if !strings.Contains(text, "pnpm") {
		t.Fatalf("turn context was cleared by a batch clear: %q", text)
	}

	// The turn ending clears both.
	context.ClearTurn()
	if !context.Empty() || context.Text() != "" {
		t.Fatalf("the turn's context survived the turn: %q", context.Text())
	}
}

func TestContextTextIsAPureRead(t *testing.T) {
	// Notes() is called again on a retried request, and the retry has to send the
	// same payload as the attempt it replaces.
	context := &Context{}
	context.AddTurn("start", EventSessionStart, "one")
	first := context.Text()
	second := context.Text()
	if first != second || first == "" {
		t.Fatalf("Text is not idempotent: %q vs %q", first, second)
	}
}

func TestContextIsTaggedWithItsSource(t *testing.T) {
	context := &Context{}
	context.AddBatch("pnpm-guard", EventPostToolUse, "The repository uses pnpm.")
	text := context.Text()
	for _, want := range []string{`<hook_context source="post_tool_use" hook="pnpm-guard">`, "</hook_context>"} {
		if !strings.Contains(text, want) {
			t.Errorf("text = %q, want %q", text, want)
		}
	}
}

func TestContextBudgetIsEnforced(t *testing.T) {
	context := &Context{}
	context.AddTurn("a", EventSessionStart, strings.Repeat("x", ContextPartBytes*2))
	if got := len([]rune(context.Text())); got > ContextTotalChars {
		t.Fatalf("text = %d runes, over the total budget", got)
	}
	if !context.Truncated() {
		t.Fatal("the truncation was not recorded")
	}
}

func TestANilContextIsUsable(t *testing.T) {
	// The call sites hold the pointer from the runtime and would otherwise need a
	// nil check in each of them; "no hooks" is the ordinary case.
	var context *Context
	context.AddTurn("a", EventSessionStart, "x")
	context.ClearBatch()
	context.ClearTurn()
	if context.Text() != "" || !context.Empty() || context.Truncated() {
		t.Fatal("a nil context did not behave like an empty one")
	}
}
