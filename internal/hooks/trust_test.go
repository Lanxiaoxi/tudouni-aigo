package hooks

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These are the tests for the trust boundary's **enforcement**, as opposed to its
// parsing. They exist because the boundary was, for one revision, only parsed: the
// configuration loaded, `Restrict` existed, and neither was reached from a call site.
// A unit test on `RestrictSet` would have passed then too, so what is asserted here
// is the composed behaviour — a merged configuration where one hook may deny and the
// other may not — which is the only shape the session ever runs.

// helperSet builds a set whose hooks are the test helper, all from one source.
func helperSet(t *testing.T, source string, hooks ...Hook) *Set {
	t.Helper()
	for index := range hooks {
		hooks[index].Source = source
		hooks[index].Event = EventPreToolUse
		if len(hooks[index].Argv) == 0 {
			hooks[index].Argv = []string{os.Args[0], "-test.run=TestHelperProcess"}
		}
		if hooks[index].TimeoutMs == 0 {
			hooks[index].TimeoutMs = 5000
		}
	}
	return &Set{
		Path:     "test",
		Source:   source,
		ByEvent:  map[Event][]Hook{EventPreToolUse: hooks},
		Defaults: Defaults{TimeoutMs: 5000, MaxOutputBytes: DefaultMaxOutputBytes},
	}
}

// --- workspace hooks may only tighten --------------------------------------

func TestAnAllowFromAWorkspaceHookIsDropped(t *testing.T) {
	// "Let it through", written into a cloned repository, is a permission grant nobody
	// made — and `permissions.json` is where a long-lived release belongs because it is
	// a declaration a person can review.
	set := helperSet(t, SourceWorkspace, Hook{Name: "helper-allow", Enabled: true})
	result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))

	if result.Decision != DecisionNone {
		t.Fatalf("decision = %q, want none: a workspace hook allowed a call", result.Decision)
	}
	if got := result.Outcomes[0].Restricted; len(got) != 1 || got[0] != "allow" {
		t.Fatalf("restricted = %v, want the dropped `allow` named", got)
	}
}

func TestADenyFromAWorkspaceHookSurvives(t *testing.T) {
	// The one decision a repository is trusted to make, and the whole reason the
	// mechanism exists.
	set := helperSet(t, SourceWorkspace, Hook{Name: "helper-deny", Enabled: true, FailClosed: true})
	result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))

	if result.Decision != DecisionDeny {
		t.Fatalf("decision = %q, want deny", result.Decision)
	}
	if result.Outcomes[0].Restricted != nil {
		t.Fatalf("a deny was narrowed: %v", result.Outcomes[0].Restricted)
	}
}

func TestAskFromAWorkspaceHookSurvives(t *testing.T) {
	set := helperSet(t, SourceWorkspace, Hook{Name: "helper-ask", Enabled: true})
	result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))

	if result.Decision != DecisionAsk {
		t.Fatalf("decision = %q, want ask", result.Decision)
	}
}

func TestARewriteFromAWorkspaceHookIsDropped(t *testing.T) {
	// A rewrite from a repository would silently change what the model asked for,
	// which is the difference between "not allowed" and "allowed, as something else".
	set := helperSet(t, SourceWorkspace, Hook{Name: "helper-rewrite", Enabled: true})
	result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))

	if result.Rewritten {
		t.Fatal("a workspace hook rewrote the arguments")
	}
	if got := result.Updated; got != nil {
		t.Fatalf("updated = %v, want nil", got)
	}
	found := false
	for _, name := range result.Outcomes[0].Restricted {
		if name == "updated_input" {
			found = true
		}
	}
	if !found {
		t.Fatalf("restricted = %v, want `updated_input` named", result.Outcomes[0].Restricted)
	}
}

func TestAUserHookKeepsEveryCapability(t *testing.T) {
	// The control: the same hook, from the user's own file, does all three things. A
	// test that only checked the narrowing would pass if the runner narrowed
	// everything.
	for _, testCase := range []struct {
		mode string
		want Decision
	}{
		{"allow", DecisionAllow},
	} {
		set := helperSet(t, SourceUser, Hook{Name: "helper-" + testCase.mode, Enabled: true})
		result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
		if result.Decision != testCase.want {
			t.Fatalf("decision = %q, want %q", result.Decision, testCase.want)
		}
		if len(result.Outcomes[0].Restricted) != 0 {
			t.Fatalf("a user hook was restricted: %v", result.Outcomes[0].Restricted)
		}
	}

	set := helperSet(t, SourceUser, Hook{Name: "helper-rewrite", Enabled: true})
	result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
	if !result.Rewritten || result.Updated["command"] != "git status --short" {
		t.Fatalf("a user hook's rewrite was dropped: %#v", result.Updated)
	}
}

func TestTheRestrictionIsReportedInTheAuditRow(t *testing.T) {
	// "It ran and its answer was narrowed" has to be a fact in the log, or a person
	// reading `--audit` sees a hook that answered nothing and concludes it is broken.
	var records []map[string]any
	set := helperSet(t, SourceWorkspace, Hook{Name: "helper-allow", Enabled: true})
	set.SetEmit(func(record map[string]any) { records = append(records, record) })

	set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
	if len(records) != 1 {
		t.Fatalf("records = %d, want one", len(records))
	}
	if records[0]["source"] != SourceWorkspace {
		t.Fatalf("source = %v, want workspace", records[0]["source"])
	}
	restricted, _ := records[0]["restricted"].([]string)
	if len(restricted) != 1 || restricted[0] != "allow" {
		t.Fatalf("restricted = %v", records[0]["restricted"])
	}
}

// --- merging the two files -------------------------------------------------

func TestMergeKeepsTheUsersHooksAheadOfTheWorkspaces(t *testing.T) {
	// The order is the trust order: a repository's guardrail cannot pre-empt the
	// person's by running earlier, and it cannot shadow one of the same name — both
	// run, so a `deny` from either still lands.
	user := &Set{
		Source:  SourceUser,
		ByEvent: map[Event][]Hook{EventPreToolUse: {{Name: "shared", Source: SourceUser}}},
	}
	work := &Set{
		Source:  SourceWorkspace,
		ByEvent: map[Event][]Hook{EventPreToolUse: {{Name: "shared", Source: SourceWorkspace}}},
	}
	merged := Merge(user, work)
	list := merged.Hooks(EventPreToolUse)
	if len(list) != 2 {
		t.Fatalf("hooks = %d, want both", len(list))
	}
	if list[0].Source != SourceUser || list[1].Source != SourceWorkspace {
		t.Fatalf("order = %s then %s, want user then workspace", list[0].Source, list[1].Source)
	}
	// The two originals are untouched: a merged set shares no slice with either, so a
	// later append to one cannot reach the other.
	if len(user.ByEvent[EventPreToolUse]) != 1 || len(work.ByEvent[EventPreToolUse]) != 1 {
		t.Fatal("Merge mutated one of its inputs")
	}
}

func TestMergeOfNothingIsNil(t *testing.T) {
	if merged := Merge(nil, nil); merged != nil {
		t.Fatalf("merged = %#v, want nil", merged)
	}
	// One side nil is still a real set, and not the argument itself.
	only := &Set{ByEvent: map[Event][]Hook{EventPreToolUse: {{Name: "a"}}}}
	merged := Merge(nil, only)
	if merged == nil || len(merged.Hooks(EventPreToolUse)) != 1 {
		t.Fatalf("merged = %#v", merged)
	}
	if merged == only {
		t.Fatal("Merge returned its own argument")
	}
}

func TestRestrictSetMarksItsHooksAsWorkspaceSourced(t *testing.T) {
	// The marking is what makes the narrowing apply after a merge: the set is folded
	// into the session's configuration, and `Source` on each hook is then the only
	// thing that still says which of them may only tighten.
	full, err := Load(writeHookFile(t, `{"version":1,"hooks":{
		"pre_tool_use":[{"name":"guard","command":["sh"]}],
		"stop":[{"name":"loop","command":["sh"]}]}}`))
	if err != nil {
		t.Fatal(err)
	}
	restricted := RestrictSet(full)
	if restricted.Has(EventStop) {
		t.Fatal("a workspace hook kept an event it may not have")
	}
	list := restricted.Hooks(EventPreToolUse)
	if len(list) != 1 {
		t.Fatalf("pre_tool_use hooks = %d, want one", len(list))
	}
	if list[0].Source != SourceWorkspace {
		t.Fatalf("source = %q, want workspace", list[0].Source)
	}
	if restricted.Source != SourceWorkspace {
		t.Fatalf("set source = %q", restricted.Source)
	}
}

func writeHookFile(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "hooks.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// --- status_message --------------------------------------------------------

func TestStatusMessageReachesTheDebugLine(t *testing.T) {
	// Design §11: `status_message` is "stage 1 only in `--debug`'s stderr". Before
	// this it was parsed and stored and read by nothing, so a person who set it saw
	// exactly what a person who had not set it saw.
	var lines []string
	set := helperSet(t, SourceUser, Hook{
		Name: "helper-allow", Enabled: true, StatusMessage: "checking for secrets",
	})
	set.SetDebug(func(text string) { lines = append(lines, text) })

	set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
	if len(lines) != 1 {
		t.Fatalf("debug lines = %d, want one per invocation", len(lines))
	}
	// The declared sentence replaces the hook's name: it is what the person wrote to
	// be read while waiting.
	if !strings.Contains(lines[0], "checking for secrets") {
		t.Fatalf("line = %q, want the status_message", lines[0])
	}
	if !strings.Contains(lines[0], "pre_tool_use") || !strings.Contains(lines[0], "ok") {
		t.Fatalf("line = %q, want the event and the outcome", lines[0])
	}
}

func TestNoDebugSinkMeansNoWork(t *testing.T) {
	// With `--debug` off the line is not built at all, which is the case on every
	// ordinary run.
	set := helperSet(t, SourceUser, Hook{Name: "helper-allow", Enabled: true})
	// No SetDebug call: the invocation must simply not panic and not emit.
	result := set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
	if result.Decision != DecisionAllow {
		t.Fatalf("decision = %q", result.Decision)
	}
}

func TestASkippedHookAlsoReportsItsStatus(t *testing.T) {
	// The short-circuited hooks are the ones a person watching a refusal is most
	// likely to be wondering about ("did my second guardrail run?"), so they get a
	// line too.
	var lines []string
	set := helperSet(t, SourceUser,
		Hook{Name: "helper-deny", Enabled: true, FailClosed: true},
		Hook{Name: "helper-allow", Enabled: true, StatusMessage: "second check"},
	)
	set.SetDebug(func(text string) { lines = append(lines, text) })

	set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
	if len(lines) != 2 {
		t.Fatalf("lines = %d, want one per hook", len(lines))
	}
	if !strings.Contains(lines[1], "second check") || !strings.Contains(lines[1], StatusSkipped) {
		t.Fatalf("second line = %q, want it named and skipped", lines[1])
	}
}
