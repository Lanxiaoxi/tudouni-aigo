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
	// OutcomeHookDenied — a `pre_tool_use` hook refused this call.
	OutcomeHookDenied = "hook_denied"
	// OutcomeHookAllowed — a `pre_tool_use` hook said yes, so nobody was asked.
	OutcomeHookAllowed = "hook_allowed"
	// OutcomeHookForcedAsk — a `pre_tool_use` hook asked for a person even though
	// the gate would have released the call on its own.
	OutcomeHookForcedAsk = "hook_forced_ask"
	// OutcomeHookNoAsker — a hook forced a question and there was nobody to ask.
	// It is separate from OutcomeNoAsker for the same reason hook_denied is
	// separate from policy_denied: "your guardrail asked and there was nobody
	// there" is a configuration problem, and "this tool needs approval and there
	// is no asker" is not.
	OutcomeHookNoAsker = "hook_no_asker"
)

// Verdict is a hook's opinion about one call, already reduced to the three words
// the gate understands.
//
// It is a value the caller fills in rather than an interface here, because
// `internal/security` must not learn how to spawn a process: the hook layer runs
// elsewhere, and what the gate needs is the answer.
type Verdict struct {
	// Decision is allow / ask / deny. "" and "none" mean "no opinion".
	Decision Decision
	// Reason is the sentence for the model, already wrapped by the caller: the
	// hook's own words plus "do not retry".
	Reason string
	// Hook names the hook that spoke, so the audit can say which one.
	Hook string
}

// NoVerdict is "the hooks said nothing", which is the state of every call on a
// machine with no hooks configured.
var NoVerdict = Verdict{}

// Advisor answers a question the gate was about to put to a person.
//
// The interface lives here and the implementation lives in `internal/agent`, for
// the same reason `AskFunc` does: the gate knows *when* a question is needed and
// nothing about how anybody is reached.
type Advisor func(question Question) Advice

// Question is what an advisor is told.
type Question struct {
	ToolName  string
	Risk      RiskLevel
	Arguments map[string]any
	// Decision is what the policy settled on. It is `DecisionAsk` on every path
	// that asks this — an advisor is only consulted where a person would have
	// been.
	Decision Decision
}

// Advice is what an advisor answered.
type Advice struct {
	// Kind is allow / ask / deny. `ask` means "ask the person after all", which is
	// only meaningful in the autopilot branch; everywhere else it is the state the
	// gate was already in.
	Kind   string
	Reason string
	Hook   string
}

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
//
// `hook` is what a `pre_tool_use` hook already answered, and `advisor` is how one
// may answer *instead of a person*. Both are optional and both default to "no
// opinion", which is what a machine with no hooks configured passes.
//
// The eleven routes in and out are ordered deliberately, and the order is the
// whole content of the table in the design:
//
//	1. policy deny                — "may not" beats everything, hook or not
//	2. hook deny                  — after the policy, before autopilot: automatic
//	                                mode removes asking, never a guardrail
//	3. hook ask                   — forces a question; with nobody to ask it is a
//	                                refusal, for the same reason autopilot is
//	4. autopilot                  — "nobody is watching", recorded before the
//	                                rules so the log cannot imply someone was
//	5. policy allow
//	6. remembered tool rule       — long-term, more specific than a hook's yes
//	7. remembered command prefix
//	8. hook allow                 — only "do not ask", never "may run"
//	9. advisor                    — answers the question that was about to be put
//	                               to a person
//	10. the person
//	11. nobody to ask             — refused
func Check(toolName string, risk RiskLevel, arguments map[string]any,
	policy Policy, asker AskFunc, memory *Memory, clock Clock, autopilot bool,
	hook Verdict, advisor Advisor) Result {

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

	// Route 2 and 3: the hook's opinion, and they come before autopilot on purpose.
	// Autopilot means "do not ask me"; it does not mean "ignore the guardrail I
	// configured". A mode that silently disabled a deny rule would make the rule
	// worth nothing exactly when it matters.
	if hook.Decision == DecisionDeny {
		text := hook.Reason
		if text == "" {
			text = fmt.Sprintf("权限拒绝：hook %s 拒绝执行 %s。不要重试同样的调用。", hook.Hook, toolName)
		}
		return Result{Denial: text, Outcome: OutcomeHookDenied, Decision: DecisionDeny}
	}
	forced := hook.Decision == DecisionAsk

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
		if forced {
			// A hook asked for a person in a run that has nobody: refused. It is
			// the same sentence OutcomeNoAsker already stands for, and it is
			// separate from it so a reader can tell "the guardrail asked" from
			// "the tool needed approval".
			return Result{
				Denial: fmt.Sprintf("权限拒绝：hook %s 要求人工审批，但这一轮没有人在场（autopilot），已拒绝。"+
					"不要重试同样的调用。", hook.Hook),
				Outcome:  OutcomeHookNoAsker,
				Decision: DecisionAsk,
			}
		}
		return Result{Outcome: OutcomeAutopilot, Decision: decision}
	}

	if decision == DecisionAllow && !forced {
		return Result{Outcome: OutcomeAutoAllowed, Decision: decision}
	}

	// A tool the user pressed `t` on in an earlier approval. This comes before the
	// no-asker check: the rule already answered the question, and having no way to
	// ask cannot change that answer — the reverse order would produce the absurd
	// result of a tool being refused because a way to ask was missing.
	//
	// It does **not** outrank a forced ask: a guardrail asking for a human is a
	// check made now, and a rule made once is not an answer to it.
	if !forced && memory != nil && memory.Has(toolName) {
		return Result{Outcome: OutcomeRuleAllowed, Decision: decision}
	}

	// The finer layer: command prefix rules.
	//
	// It comes after the whole-tool rule so that the reason reported is always the
	// one that suffices on its own. When the tool is already exempt as a whole,
	// reporting "a command rule matched" would suggest that removing that rule
	// brings the question back, and it would not.
	if !forced && memory != nil {
		if command, ok := CommandOf(toolName, arguments); ok {
			if matched, found := Covered(command, memory.Prefixes(), isWindows()); found {
				return Result{Outcome: OutcomeCommandAllowed, Decision: decision, Rule: matched}
			}
		}
	}

	// Route 8: a hook said yes. It comes after the two remembered layers because
	// "I allowed this once, in advance" is a longer-lived and more specific reason,
	// and the audit should record that one when both apply. What the hook's yes buys
	// is stopping the question, never a release from a "may not".
	if hook.Decision == DecisionAllow && !forced {
		return Result{Outcome: OutcomeHookAllowed, Decision: decision}
	}
	if forced {
		// Held so the route that answers it is visible in the audit even when the
		// question then goes to a person.
		decision = DecisionAsk
	}

	if asker == nil {
		if forced {
			return Result{
				Denial: fmt.Sprintf("权限拒绝：hook %s 要求人工审批，但当前未配置审批方式，已拒绝。"+
					"不要重试同样的调用。", hook.Hook),
				Outcome:  OutcomeHookNoAsker,
				Decision: DecisionAsk,
			}
		}
		// Fail closed. A call that needs approval with no way to ask is refused;
		// it is never allowed by default.
		return Result{
			Denial: fmt.Sprintf("权限拒绝：%s 需要人工审批，但当前未配置审批方式，已拒绝。"+
				"不要重试同样的调用。", toolName),
			Outcome:  OutcomeNoAsker,
			Decision: decision,
		}
	}

	// Route 9: the hook that answers in a person's place. It is consulted **only
	// here** — where a person was about to be asked — which is what keeps the two
	// mechanisms distinct: `pre_tool_use` runs on every call and may force a
	// question, while `permission_request` saves a question rather than adding one.
	if advisor != nil {
		advice := advisor(Question{
			ToolName:  toolName,
			Risk:      risk,
			Arguments: arguments,
			Decision:  DecisionAsk,
		})
		switch advice.Kind {
		case string(DecisionAllow):
			return Result{Outcome: OutcomeHookAllowed, Decision: DecisionAllow}
		case string(DecisionDeny):
			text := advice.Reason
			if text == "" {
				text = fmt.Sprintf("权限拒绝：hook %s 拒绝执行 %s。不要重试同样的调用。", advice.Hook, toolName)
			}
			return Result{Denial: text, Outcome: OutcomeHookDenied, Decision: DecisionDeny}
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
		outcome := OutcomeApproved
		if forced {
			outcome = OutcomeHookForcedAsk
		}
		return Result{
			Outcome:    outcome,
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
