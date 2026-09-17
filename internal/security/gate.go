package security

import (
	"fmt"
	"sort"
	"time"
)

// AskFunc answers one question: may this call run?
//
// The return type stays a boolean on purpose. "Remember this" is written into the
// memory by the asker itself, and the gate discovers what was added by comparing
// a snapshot taken before the question with one taken after. That keeps the
// contract between the two small enough to reason about.
type AskFunc func(toolName string, risk RiskLevel, arguments map[string]any) bool

// Outcome is why a verdict came out the way it did.
//
// Every route in and out is recorded separately because they answer different
// questions afterwards. "Who approved this" and "the policy forbade it outright"
// are different when blame is assigned; "a person approved this" and "a person
// approved something like this once" and "a rule the user wrote in advance let it
// through" are three different things — respectively, that somebody looked this
// time, and two kinds of release with nobody in the room.
const (
	// OutcomeAutoAllowed — the risk level is on the list; nobody was asked.
	OutcomeAutoAllowed = "auto_allowed"
	// OutcomeAutopilot — this run has nobody to ask.
	OutcomeAutopilot = "autopilot"
	// OutcomeRuleAllowed — this tool was allowed by name in an earlier approval.
	OutcomeRuleAllowed = "rule_allowed"
	// OutcomeCommandAllowed — this command matched a prefix rule.
	OutcomeCommandAllowed = "command_allowed"
	// OutcomeApproved — a human was asked this time and said yes.
	OutcomeApproved = "approved"
	// OutcomeUserDenied — a human was asked this time and said no.
	OutcomeUserDenied = "user_denied"
	// OutcomePolicyDenied — the policy forbids it; nobody needed to be asked.
	OutcomePolicyDenied = "policy_denied"
	// OutcomeNoAsker — it needs approval and there is no way to ask; refused.
	OutcomeNoAsker = "no_asker"
)

// Result is one permission verdict.
type Result struct {
	// Denial is the text fed back to the model, or "" when the call may run.
	Denial   string
	Outcome  string
	Decision Decision
	// WaitedMs is set only when a human was actually asked.
	WaitedMs *int
	// Remembered lists rules this verdict added. An approval that also changes
	// future behaviour has to be recorded: it is not half of "who approved what".
	Remembered []string
	// Rule is the command prefix that matched, when one did. It answers "why was
	// this not asked about" — without it the log shows only that nobody was asked,
	// not on what authority.
	Rule Rule
}

// Clock is the injected time source. The same one is used by the gate and by the
// asker, because durations from model calls, permissions and tool results are
// added together and mixing clocks mixes units.
type Clock func() float64

// PerfClock is the default clock. It is monotonic, so it measures durations
// rather than wall time.
func PerfClock() float64 { return float64(time.Since(processStart).Nanoseconds()) / 1e9 }

var processStart = time.Now()

// Check decides whether one tool call may run.
//
// A refusal goes back to the model as text rather than ending the task: what a
// user refuses is usually "this way of doing it", and the model deserves a chance
// to try another.
//
// Autopilot only covers asking. It does not bypass the deny list, the workspace
// boundary or control-plane writes — those are "may not", not "should not ask".
func Check(toolName string, risk RiskLevel, arguments map[string]any,
	policy Policy, asker AskFunc, memory *Memory, clock Clock, autopilot bool) Result {

	if clock == nil {
		clock = PerfClock
	}

	decision := policy.Decide(toolName, risk)

	if decision == DecisionDeny {
		return Result{
			Denial: fmt.Sprintf("权限拒绝：%s 被权限策略禁止执行。"+
				"不要重试同样的调用，请改用其它方式完成任务。", toolName),
			Outcome:  OutcomePolicyDenied,
			Decision: decision,
		}
	}

	// Autopilot sits before both rule checks so the audit can answer one question
	// cleanly: "was anybody watching during this run?" If it sat after, tools on
	// the level list would be recorded as auto_allowed and rule hits as
	// command_allowed — both of which look exactly like an ordinary session with
	// approvals on, so the answer could only be inferred.
	//
	// It also outranks the rules: autopilot alone explains why nobody was asked,
	// and it is the more important fact — a rule is long-term policy, autopilot is
	// this run's state.
	if autopilot {
		return Result{Outcome: OutcomeAutopilot, Decision: decision}
	}

	if decision == DecisionAllow {
		return Result{Outcome: OutcomeAutoAllowed, Decision: decision}
	}

	// A tool the user pressed `t` on in an earlier approval. This comes before the
	// no-asker check: the rule already answered the question, and having no way to
	// ask cannot change that answer — the reverse order would produce the absurd
	// result of a tool being refused because a way to ask was missing.
	if memory != nil && memory.Has(toolName) {
		return Result{Outcome: OutcomeRuleAllowed, Decision: decision}
	}

	// The finer layer: command prefix rules.
	//
	// It comes after the whole-tool rule so that the reason reported is always the
	// one that suffices on its own. When the tool is already exempt as a whole,
	// reporting "a command rule matched" would suggest that removing that rule
	// brings the question back, and it would not.
	if memory != nil {
		if command, ok := CommandOf(toolName, arguments); ok {
			if matched, found := Covered(command, memory.Prefixes(), isWindows()); found {
				return Result{Outcome: OutcomeCommandAllowed, Decision: decision, Rule: matched}
			}
		}
	}

	if asker == nil {
		// Fail closed. A call that needs approval with no way to ask is refused;
		// it is never allowed by default.
		return Result{
			Denial: fmt.Sprintf("权限拒绝：%s 需要人工审批，但当前未配置审批方式，已拒绝。"+
				"不要重试同样的调用。", toolName),
			Outcome:  OutcomeNoAsker,
			Decision: decision,
		}
	}

	var before []string
	if memory != nil {
		before = memory.Tools()
	}

	started := clock()
	approved := asker(toolName, risk, arguments)
	waited := int((clock() - started) * 1000)

	if approved {
		var remembered []string
		if memory != nil {
			remembered = difference(memory.Tools(), before)
		}
		return Result{
			Outcome:    OutcomeApproved,
			Decision:   decision,
			WaitedMs:   &waited,
			Remembered: remembered,
		}
	}

	return Result{
		Denial: fmt.Sprintf("权限拒绝：用户拒绝执行 %s。"+
			"不要重复同样的调用；请换一种方式，或先说明你为什么需要执行它。", toolName),
		Outcome:  OutcomeUserDenied,
		Decision: decision,
		WaitedMs: &waited,
	}
}

func difference(after, before []string) []string {
	seen := map[string]bool{}
	for _, name := range before {
		seen[name] = true
	}
	var out []string
	for _, name := range after {
		if !seen[name] {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// isWindows is the platform the command parser should assume.
func isWindows() bool { return platformIsWindows }
