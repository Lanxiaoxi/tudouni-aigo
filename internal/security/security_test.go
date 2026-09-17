package security

import "testing"

func TestDenyWinsOverAutoApprove(t *testing.T) {
	policy := Policy{AutoApprove: []string{"low", "medium"}, DenyTools: []string{"shell"}}
	// The blacklist is checked first: "never" beats "usually", even when the level
	// would otherwise have been released.
	if got := policy.Decide("shell", RiskLow); got != DecisionDeny {
		t.Fatalf("Decide = %q, want deny", got)
	}
	if got := policy.Decide("read_file", RiskLow); got != DecisionAllow {
		t.Fatalf("Decide = %q, want allow", got)
	}
	if got := policy.Decide("write_file", RiskHigh); got != DecisionAsk {
		t.Fatalf("Decide = %q, want ask", got)
	}
}

func TestEmptyPolicyAsksAboutEverything(t *testing.T) {
	// Never fail open: with nothing configured, every call is a question.
	policy := Policy{}
	for _, risk := range []RiskLevel{RiskLow, RiskMedium, RiskHigh} {
		if got := policy.Decide("anything", risk); got != DecisionAsk {
			t.Fatalf("risk %s: Decide = %q, want ask", risk, got)
		}
	}
}

func TestCommandCoverageRequiresEverySegment(t *testing.T) {
	// The classic mistake is matching only the first segment. `git status && rm -rf
	// build` under the rule `git` must still be asked about.
	rules := []Rule{{"git"}}
	if _, ok := Covered("git status && rm -rf build", rules, false); ok {
		t.Fatal("a chained command with an uncovered segment must not be covered")
	}
	if _, ok := Covered("git status", rules, false); !ok {
		t.Fatal("a single covered command must be covered")
	}
}

func TestCommandCoverageIsByTokensNotPrefixes(t *testing.T) {
	// `git commit` must not cover `git commit-graph write`: a string prefix match
	// would, and that is a silent release.
	rules := []Rule{{"git", "commit"}}
	if _, ok := Covered("git commit-graph write", rules, false); ok {
		t.Fatal("token matching must not be fooled by a longer token")
	}
	if _, ok := Covered("git commit -m x", rules, false); !ok {
		t.Fatal("a proper token prefix must match")
	}
}

func TestRedirectionAbandonsTheJudgement(t *testing.T) {
	rules := []Rule{{"echo"}}
	// A redirection turns a read-only-looking command into a write, so the parser
	// refuses to guess and the caller has to ask.
	if _, ok := Covered("echo hi > file", rules, false); ok {
		t.Fatal("a command with a redirection must not be covered")
	}
	if _, ok := Covered("echo $(whoami)", rules, false); ok {
		t.Fatal("command substitution must not be covered")
	}
}

func TestSuggestPrefixRefusesChains(t *testing.T) {
	// A key that looks like "never ask about this again" and remembers nothing is
	// worse than not offering the option.
	if _, ok := SuggestPrefix("git status && rm -rf build", false); ok {
		t.Fatal("a chained command must not suggest a prefix")
	}
	rule, ok := SuggestPrefix("git add -p x.py", false)
	if !ok || len(rule) != 2 || rule[0] != "git" || rule[1] != "add" {
		t.Fatalf("SuggestPrefix = %v, %v", rule, ok)
	}
	rule, ok = SuggestPrefix("ls -la", false)
	if !ok || len(rule) != 1 || rule[0] != "ls" {
		t.Fatalf("SuggestPrefix = %v, %v", rule, ok)
	}
}

func TestRuleRoundTripQuotesTokensWithSpaces(t *testing.T) {
	// A rule that is written back and read again must mean the same thing;
	// otherwise the configuration file is broken by its own save step.
	rule, err := ParseRule(`git commit -m 'wip wip'`, false)
	if err != nil {
		t.Fatal(err)
	}
	text, err := FormatRule(rule)
	if err != nil {
		t.Fatal(err)
	}
	again, err := ParseRule(text, false)
	if err != nil {
		t.Fatalf("the written form does not parse back: %v (%q)", err, text)
	}
	if len(again) != len(rule) {
		t.Fatalf("round trip changed the rule: %v then %v", rule, again)
	}
}

func TestRuleWithSeparatorIsRejectedAtLoadTime(t *testing.T) {
	// Catching this at load time matters: "one rule was read as two" has to be said
	// at startup instead of surfacing later as a quietly released approval.
	if _, err := ParseRule("git add && rm", false); err == nil {
		t.Fatal("a rule containing a separator must be rejected")
	}
	if _, err := ParseRule("echo > file", false); err == nil {
		t.Fatal("a rule containing a redirection must be rejected")
	}
}

func TestGateRewardsTheOrderOfShortCircuits(t *testing.T) {
	memory := NewMemory([]string{"read_file"}, nil, "test", nil)
	policy := Policy{AutoApprove: []string{"low"}}
	clock := func() float64 { return 0 }

	// A denied tool is refused before anything else is considered.
	if result := Check("shell", RiskHigh, nil,
		Policy{DenyTools: []string{"shell"}}, AlwaysAllow, memory, clock, true); result.Outcome != OutcomePolicyDenied {
		t.Fatalf("outcome = %q, want policy_denied", result.Outcome)
	}

	// Autopilot outranks the rules, so "was anybody watching" stays answerable.
	if result := Check("shell", RiskHigh, nil, policy, AlwaysAllow, memory, clock, true); result.Outcome != OutcomeAutopilot {
		t.Fatalf("outcome = %q, want autopilot", result.Outcome)
	}

	// A remembered tool is released without asking, and without needing an asker.
	if result := Check("read_file", RiskHigh, nil, policy, nil, memory, clock, false); result.Outcome != OutcomeRuleAllowed {
		t.Fatalf("outcome = %q, want rule_allowed", result.Outcome)
	}

	// No asker and no rule means refusal, never a release.
	result := Check("write_file", RiskMedium, nil, policy, nil, memory, clock, false)
	if result.Outcome != OutcomeNoAsker || result.Denial == "" {
		t.Fatalf("outcome = %q denial = %q; a missing channel must fail closed", result.Outcome, result.Denial)
	}
}

func TestAutopilotDoesNotBypassTheDenyList(t *testing.T) {
	// Autopilot only covers asking. The deny list is "may not", not "should not ask".
	result := Check("shell", RiskHigh, nil,
		Policy{DenyTools: []string{"shell"}}, AlwaysAllow, nil, func() float64 { return 0 }, true)
	if result.Outcome != OutcomePolicyDenied {
		t.Fatalf("outcome = %q, want policy_denied", result.Outcome)
	}
}

func TestMemoryIsIdempotentAndReportsSaveFailure(t *testing.T) {
	saves := 0
	memory := NewMemory(nil, nil, "test", func(tools []string, prefixes []Rule) error {
		saves++
		return nil
	})
	memory.Grant("shell")
	memory.Grant("shell")
	if saves != 1 {
		t.Fatalf("saves = %d, want 1", saves)
	}

	// A failed save is reported and swallowed: agreeing and then failing to
	// remember is worse than refusing, but crashing on the save is worst of all.
	var reported []string
	memory.Sink = func(text string) { reported = append(reported, text) }
	memory.onChange = func([]string, []Rule) error { return errStub }
	memory.Grant("other")
	if len(reported) != 1 || reported[0] != SaveFailedNote {
		t.Fatalf("reported = %v", reported)
	}
}

var errStub = stubError("cannot write")

type stubError string

func (e stubError) Error() string { return string(e) }
