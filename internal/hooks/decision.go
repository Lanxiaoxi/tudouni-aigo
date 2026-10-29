package hooks

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Decision is what one hook said about the action it was shown.
//
// The vocabulary is five words and the whole design leans on it: `allow` (this
// one says go), `ask` (make a person decide), `deny` (stop), `block` (an alias of
// `deny`, kept because every other implementation in this space spells it that
// way and a script written for one of them should run here), and `none` (no
// opinion). `none` is not `allow`: it does not vote, which is what lets an
// observer that only wanted to look stay out of the decision.
type Decision string

const (
	DecisionNone  Decision = "none"
	DecisionAllow Decision = "allow"
	DecisionAsk   Decision = "ask"
	DecisionDeny  Decision = "deny"
	DecisionBlock Decision = "block"
)

// Params is what one invocation of one hook may do.
//
// The set is a property of the event rather than of a configuration: a hook on
// `post_tool_use` returning `updated_input` is not a powerful hook, it is a hook
// whose answer has nowhere to go, and quietly accepting it would teach its author
// that it works.
func (e Event) Params() params {
	switch e {
	case EventPreToolUse:
		return params{decide: true, updatedInput: true, context: false, reason: true}
	case EventPermissionRequest:
		return params{decide: true, updatedInput: false, context: false, reason: true}
	case EventUserPromptSubmit:
		return params{decide: true, updatedInput: false, context: true, reason: true}
	case EventSessionStart, EventPostToolUse, EventPreCompact:
		return params{decide: false, updatedInput: false, context: true, reason: false}
	case EventStop:
		return params{decide: true, updatedInput: false, context: false, reason: true}
	case EventSubagentStart:
		return params{decide: true, updatedInput: false, context: false, reason: true}
	default:
		// session_end, subagent_stop: observed and nothing else.
		return params{}
	}
}

// params says which outputs an event honours.
type params struct {
	decide       bool
	updatedInput bool
	context      bool
	reason       bool
}

// Output is one hook's parsed stdout.
//
// `UpdatedInput` is a pointer-to-map rather than a map so "the hook said nothing"
// and "the hook said `{}`" are different: the second one is an instruction to
// delete every key, which the merge rules implement rather than special-case.
type Output struct {
	Decision      Decision
	Reason        string
	UpdatedInput  map[string]any
	HasUpdated    bool
	Context       string
	SystemMessage string
}

// Outcome is how one hook's invocation ended. It is a value on the `Outcome`
// slice, so the audit has the same vocabulary the runner saw.
type Outcome struct {
	Hook       string
	Event      Event
	Decision   Decision
	Status     string
	Reason     string
	DurationMs int
	// TimeoutMs is the budget this invocation was given, so a timeout can say
	// what it timed out against.
	TimeoutMs    int
	ExitCode     *int
	StdoutBytes  int
	ContextChars int
	UpdatedInput bool
	// ReasonText is a 200-character preview, and nothing more: hook output is
	// user text and the log has never carried bodies.
	ReasonPreview string
	// Cancelled says the turn ended while the hook was running, which is not the
	// hook's fault and must not be reported as a timeout to anybody deciding
	// whether to keep the hook.
	Cancelled bool
	// Source is `user` or `workspace`: which file the hook came from.
	Source string
	// Restricts lists the capabilities this hook tried to use and was not allowed
	// to, because it came from a workspace. It is empty for a user-level hook.
	//
	// It exists so "my repository's guardrail tried to allow this and could not" is a
	// fact in the log rather than a silence: the hook ran, and a reader needs to know
	// that its answer was narrowed rather than obeyed.
	Restricted []string
	// Tool is the tool name the invocation was about, when the event had one. It is
	// carried for the debug line and the `hook_result` record, both of which name it.
	Tool string
}

// Hook statuses. They are the values `hook_result.status` takes.
const (
	StatusOK        = "ok"
	StatusDenied    = "denied"
	StatusTimeout   = "timeout"
	StatusSpawn     = "spawn_error"
	StatusExit      = "exit_error"
	StatusBadOutput = "bad_output"
	StatusTruncated = "truncated"
	StatusSkipped   = "skipped"
)

// Result is the aggregated answer for one event: one decision, one context blob,
// and one row per hook for the audit.
//
// It deliberately has no "continue the loop" field. Stopping has exactly one road
// in this program (`ShouldStop` / interrupt), and a second one would make "why did
// this stop" a question with two answers that were bound to disagree.
type Result struct {
	Decision Decision
	Reason   string
	// Updated is the merged arguments for `pre_tool_use`, nil when no hook
	// rewrote anything.
	Updated map[string]any
	// Rewritten reports that Updated came from a hook, so `{}` (delete
	// everything) is not confused with "no rewrite".
	Rewritten bool
	// Context is what the hooks want appended to the request tail, rendered and
	// ready to paste. It never enters history; the caller owns where it goes.
	Context string
	// Parts is the same content before rendering, one entry per contributing hook.
	// It exists because the caller needs the source: the tag says which hook said
	// what, and a caller holding only the rendered blob could not add to it without
	// nesting one block inside another.
	Parts    []Part
	System   string
	Outcomes []Outcome
	// DeniedBy names the hook that short-circuited the chain, for the sentence the
	// model reads.
	DeniedBy string
	// Ask names the hook that forced a person to decide, when one did. It is a
	// separate field from DeniedBy because "refused" and "needs a human" draw
	// differently and read back as two different events.
	Ask string
	// Failed says the chain produced a decision **because a hook broke** rather
	// than because a hook answered. The model's text distinguishes the two: "hook
	// refused" and "hook timed out" call for different repairs.
	Failed  bool
	Failure string
	// Skipped lists hooks that never ran, in configuration order. The audit says
	// so for each; the field is here because "why did hook 3 not run" is answered
	// by the short circuit and has to be visible.
	Skipped []string
}

// Any reports whether anything happened at all.
//
// It is what a caller uses to skip the rest of the work when no hook spoke. "Nothing
// happened" means both that nobody decided and that nobody was even executed: a chain
// of two observers that both said nothing is not the same thing as an event with no
// hooks, and only the second one lets a caller drop the context it was about to build.
func (r Result) Any() bool {
	return r.Decision != "" && r.Decision != DecisionNone || len(r.Outcomes) > 0
}

// ParseOutput reads a hook's stdout.
//
// Rules, and the strictness is the point:
//   - empty output is "no opinion", which is what a hook that only exists to have
//     a side effect produces;
//   - the first non-space byte must be `{`, and the whole document must be one
//     object. Extra text after it is an error rather than being ignored: a script
//     that printed a debug line and then its decision would otherwise silently
//     lose the decision;
//   - an unknown `decision` **is an error**. A typo'd `deny` that turned into "no
//     opinion" is the hardest failure in this feature to diagnose.
func ParseOutput(raw []byte, event Event) (Output, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return Output{Decision: DecisionNone}, nil
	}
	var value any
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	if err := decoder.Decode(&value); err != nil {
		return Output{}, fmt.Errorf("the output is not JSON: %v", err)
	}
	// Anything after the object is a second document or a stray line.
	if decoder.More() {
		return Output{}, fmt.Errorf("the output carries more than one JSON value")
	}
	object, ok := value.(map[string]any)
	if !ok {
		return Output{}, fmt.Errorf("the output must be a JSON object")
	}

	out := Output{Decision: DecisionNone}
	if rawDecision, present := object["decision"]; present && rawDecision != nil {
		text, ok := rawDecision.(string)
		if !ok {
			return Output{}, fmt.Errorf("`decision` must be a string")
		}
		switch Decision(strings.ToLower(strings.TrimSpace(text))) {
		case DecisionAllow:
			out.Decision = DecisionAllow
		case DecisionAsk:
			out.Decision = DecisionAsk
		case DecisionDeny, DecisionBlock:
			out.Decision = DecisionDeny
		case DecisionNone, "":
			out.Decision = DecisionNone
		default:
			return Output{}, fmt.Errorf("unknown decision %q (known: allow, ask, deny, block, none)", text)
		}
	}

	// An event that cannot decide cannot be given a decision. Refusing is better
	// than ignoring: a script author who attached `deny` to `post_tool_use` wanted
	// something to happen that this design does not do, and a silent `none` would
	// leave them believing it had.
	if !event.Params().decide && out.Decision != DecisionNone {
		return Output{}, fmt.Errorf("event %s does not accept a decision", event)
	}

	if text, ok := object["reason"].(string); ok {
		out.Reason = strings.TrimSpace(text)
	}
	if text, ok := object["additional_context"].(string); ok {
		out.Context = strings.TrimSpace(text)
	}
	if text, ok := object["system_message"].(string); ok {
		out.SystemMessage = strings.TrimSpace(text)
	}
	if rawUpdated, present := object["updated_input"]; present && rawUpdated != nil {
		updated, ok := rawUpdated.(map[string]any)
		if !ok {
			return Output{}, fmt.Errorf("`updated_input` must be an object")
		}
		if !event.Params().updatedInput {
			return Output{}, fmt.Errorf("event %s does not accept `updated_input`", event)
		}
		out.UpdatedInput = updated
		out.HasUpdated = true
	}
	if out.Context != "" && !event.Params().context {
		return Output{}, fmt.Errorf("event %s does not accept `additional_context`", event)
	}
	if out.Decision == DecisionDeny && out.Reason == "" {
		// A refusal with no reason is the worst possible message for the model: it
		// knows to stop and not why. Requiring one costs a hook author one line and
		// saves the model a guessing game.
		return Output{}, fmt.Errorf("a `deny` needs a `reason`")
	}
	return out, nil
}

// MergeArguments is `mergeUpdated` for callers outside this package.
//
// The rules are stated once, here, because a caller that re-implemented them —
// even faithfully today — would drift the day one of the two changed, and the
// difference would show up as "the same hook works on one event and not the other".
// Objects merge recursively, arrays and scalars replace wholesale, and `null`
// deletes the key.
func MergeArguments(base, patch map[string]any) map[string]any {
	return mergeUpdated(copyObject(base), patch)
}

// mergeUpdated applies one hook's `updated_input` to the running arguments.
//
// Objects merge recursively, arrays and scalars replace wholesale, and `null`
// deletes the key. That rule is what lets an ordinary hook say "add this one
// field" without having to restate the whole object, while still leaving a way to
// remove something on purpose.
func mergeUpdated(base, patch map[string]any) map[string]any {
	if base == nil {
		base = map[string]any{}
	}
	for key, value := range patch {
		if value == nil {
			delete(base, key)
			continue
		}
		if patchObject, ok := value.(map[string]any); ok {
			existing, _ := base[key].(map[string]any)
			base[key] = mergeUpdated(copyObject(existing), patchObject)
			continue
		}
		base[key] = value
	}
	return base
}

// copyObject is a shallow copy, because mergeUpdated writes into what it is given
// and the caller's map may be the model's own arguments.
func copyObject(source map[string]any) map[string]any {
	if source == nil {
		return map[string]any{}
	}
	out := make(map[string]any, len(source))
	for key, value := range source {
		out[key] = value
	}
	return out
}

// denyText is what the model is told when a hook refused a call.
//
// The hook's own words are kept exactly, with one sentence around them, because
// the reason is the user's and rewriting it would be this program putting words in
// their mouth. "Do not retry" is the part the model actually needs: without it a
// refusal reads as a transient failure and it tries again.
func denyText(hookName, reason string) string {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = "no reason was given"
	}
	return fmt.Sprintf("hook 拒绝：%s（hook: %s）。不要重试同样的调用；换一种方式，或先向用户说明原因。",
		reason, hookName)
}

// failureText is what the model is told when a gate hook broke.
//
// It names **which** break it was, because the repairs differ — a timeout means
// "make it faster", a non-zero exit means "go and look at the script", bad output
// means "print one JSON object" — and a reader looking at the same sentence in the
// audit benefits from it too. The last clause is aimed at that reader rather than
// at the model: `--no-hooks` is not something the model can act on, but it is the
// first thing the person reading the log needs.
func failureText(hookName, failure string) string {
	return fmt.Sprintf("hook %s %s，按 fail_closed 拒绝。不要重试；先修 hook，或用 --no-hooks 启动。",
		hookName, failure)
}

// promptBlockedReason is the text a front end shows when a hook refused a prompt.
func promptBlockedReason(hookName, reason string) string {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = "no reason was given"
	}
	return fmt.Sprintf("%s（hook: %s）", reason, hookName)
}
