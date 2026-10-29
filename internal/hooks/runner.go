package hooks

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/process"
)

// Runner is the one method every caller needs.
//
// It is an interface rather than a concrete `*Set` so a caller can be written
// against "somebody may be listening" instead of "a configuration was loaded":
// nil is the legal "no hooks at all" value, and every call site is written to
// accept it. That is what keeps the feature from turning into a branch in every
// function that existed before it.
type Runner interface {
	Fire(ctx context.Context, envelope Envelope) Result
}

// Filter is the optional "is anybody listening" question.
//
// It is separate from `Runner` rather than part of it, and separate for a reason
// that is not about tidiness: a runner that cannot answer is assumed to be
// listening, which is the safe direction — one extra consultation is a process the
// user configured, while a wrongly skipped one is a guardrail that silently does
// nothing.
type Filter interface {
	Has(event Event) bool
}

// Configurable is what the runtime holds: a runner it can install an audit sink on.
//
// The separation exists because `Set` is loaded before the runtime does, and the
// sink is `runtime.onEvent`, which does not exist until assembly finishes. Every
// `hook_result` goes through that one exit, which is what makes "one row per
// execution" a property of the executor rather than of its callers.
type Configurable interface {
	Runner
	Filter
	SetEmit(emit func(record map[string]any))
	SetDebug(debug func(text string))
}

// The compile-time assertion: `*Set` is what the runtime holds, and a method
// signature drifting away from the interface would otherwise surface as a build
// failure one package away from the code that broke it.
var _ Configurable = (*Set)(nil)

// Fire runs every hook attached to this event and aggregates their answers.
//
// One hook is one process, executed serially in configuration order. Serial is a
// decision rather than a shortcut: two guardrails both rewriting one call's
// arguments in parallel would have a merge order decided by the scheduler, and the
// same session replayed twice would produce two different requests.
//
// A nil `Set` fires nothing, which is the state of a machine with no `hooks.json`.
func (s *Set) Fire(ctx context.Context, envelope Envelope) Result {
	if s == nil {
		return Result{}
	}
	list := s.ByEvent[envelope.Event]
	if len(list) == 0 {
		return Result{}
	}
	if ctx == nil {
		ctx = context.Background()
	}

	result := Result{Decision: DecisionNone}
	var contexts []Part
	arguments := copyObject(envelope.Tool.args())
	rewritten := false

	for _, hook := range list {
		if !hook.Enabled {
			continue
		}
		// The matcher is consulted before the process is started, so a hook that
		// is not interested costs nothing at all.
		if envelope.Event.ToolEvent() && !hook.matches(envelope.Tool.name()) {
			continue
		}

		// A `deny` ends the chain: running the rest would cost a process each and
		// would make "why was this refused" depend on whichever hook ran last.
		//
		// The short-circuited hooks still get an audit row, with `status: skipped`.
		// "Not run" and "not configured" are different facts, and a log that shows
		// only the hook that spoke makes the second look like the first.
		if result.Decision == DecisionDeny {
			result.Skipped = append(result.Skipped, hook.Name)
			skipped := Outcome{
				Hook: hook.Name, Event: envelope.Event, Decision: DecisionNone,
				Status: StatusSkipped, Source: hook.Source, Tool: envelope.Tool.name(),
			}
			result.Outcomes = append(result.Outcomes, skipped)
			s.emitHookResult(skipped, envelope)
			s.debugLine(hook, skipped)
			continue
		}

		// Each hook sees the arguments as the hooks before it left them; that is
		// what makes two rewriters compose rather than overwrite one another.
		sent := envelope
		// Named per invocation rather than once for the event: `hook_name` is how a
		// script knows which of several hooks on the same event it is, and a runner
		// that left it to the caller would give every one of them the first name.
		sent.HookName = hook.Name
		if sent.Tool != nil {
			tool := *envelope.Tool
			tool.Input = copyObject(arguments)
			sent.Tool = &tool
		}

		output, outcome := s.runOne(ctx, hook, sent)
		// A workspace hook's answer is tightened before it is aggregated, and the
		// audit row is written **after** that so the log reports the decision that
		// actually took effect rather than the one the hook would have made.
		output = s.tighten(hook, output, &outcome)
		result.Outcomes = append(result.Outcomes, outcome)

		// The audit row is written here rather than by the caller for one reason:
		// there is exactly one writer, so "one hook_result per execution" cannot
		// depend on which call site fired the hook.
		s.emitHookResult(outcome, envelope)
		s.debugLine(hook, outcome)

		if outcome.Status != StatusOK && outcome.Status != StatusDenied {
			// The hook failed. Whether that ends the call is the event's decision,
			// not this loop's — see the `fail_closed` branch below.
			if hook.FailClosed && envelope.Event.Params().decide {
				result.Decision = DecisionDeny
				result.DeniedBy = hook.Name
				result.Failed = true
				result.Failure = failureReason(outcome)
				result.Reason = failureText(hook.Name, result.Failure)
				continue
			}
			continue
		}

		if outcome.Decision == DecisionDeny {
			result.Decision = DecisionDeny
			result.DeniedBy = hook.Name
			result.Reason = denyText(hook.Name, output.Reason)
			continue
		}
		// `ask` is sticky: once any hook asked for a human, a later `allow` cannot
		// turn that back into an automatic release. The reverse order — allow
		// winning because it came later — is how "I configured a check" quietly
		// stops checking.
		if outcome.Decision == DecisionAsk && result.Decision != DecisionDeny {
			result.Decision = DecisionAsk
			// `Ask` names the hook that asked, which is what the audit and the
			// model's sentence need; it is **not** `DeniedBy`, because nothing was
			// denied and a front end reading that field would draw the wrong line.
			if result.Ask == "" {
				result.Ask = hook.Name
			}
			if result.Reason == "" {
				result.Reason = strings.TrimSpace(output.Reason)
			}
		}
		if outcome.Decision == DecisionAllow && result.Decision == DecisionNone {
			result.Decision = DecisionAllow
		}

		if output.HasUpdated && envelope.Event.Params().updatedInput {
			arguments = mergeUpdated(arguments, output.UpdatedInput)
			rewritten = true
			result.Outcomes[len(result.Outcomes)-1].UpdatedInput = true
		}
		if output.Context != "" && envelope.Event.Params().context {
			contexts = append(contexts, Part{
				Hook:  hook.Name,
				Event: envelope.Event,
				Text:  output.Context,
			})
		}
		if output.SystemMessage != "" && result.System == "" {
			result.System = output.SystemMessage
		}
	}

	if rewritten {
		result.Updated = arguments
		result.Rewritten = true
	}
	if len(contexts) > 0 {
		result.Parts = contexts
		result.Context = RenderContext(contexts)
	}
	return result
}

// tighten applies the rule a **workspace** hook lives under, to one hook's answer.
//
// "A repository may only make the gate stricter" is the whole of phase 2's trust
// model, and it has to be enforced **here**, per invocation, rather than by the set
// it came from: a merged configuration holds the person's hooks and the repository's
// in one list, so only the hook's own `Source` says which rules apply to it.
//
// What is dropped is dropped **after** the hook ran and after its audit row was
// written, and that ordering is deliberate: "this repository's guardrail fired and
// tried to allow something" stays visible in the log, instead of the hook appearing
// never to have run. The returned names say which capabilities were taken away, so
// the caller can report them rather than silently ignore them.
//
// `ask` needs no special case: it is one of the two decisions a workspace hook may
// make, and it can only ever make the gate stricter.
func (s *Set) tighten(hook Hook, output Output, outcome *Outcome) Output {
	if hook.Source != SourceWorkspace {
		return output
	}

	if output.HasUpdated {
		// A rewrite from a repository would silently change what the model asked for,
		// which is the difference between "this call is not allowed" and "this call is
		// allowed, but as something else".
		output.UpdatedInput = nil
		output.HasUpdated = false
		outcome.UpdatedInput = false
		outcome.Restricted = append(outcome.Restricted, "updated_input")
	}
	if output.Context != "" {
		// Automatic injection is the amplifier a prompt-injection needs: the text
		// arrives as the runtime's own note, ahead of whatever the person asked for.
		output.Context = ""
		outcome.Restricted = append(outcome.Restricted, "additional_context")
	}
	if output.Decision == DecisionAllow {
		// A workspace may not allow: "let it through" written into a cloned
		// repository is a permission grant nobody made. `permissions.json` is where a
		// long-lived release belongs, and it is reviewable as a declaration.
		output.Decision = DecisionNone
		outcome.Decision = DecisionNone
		outcome.Restricted = append(outcome.Restricted, "allow")
	}
	return output
}

// matches reports whether this hook wants the tool.
//
// An empty matcher matches everything; anything else is an RE2 pattern matched
// against the tool name, case-sensitively, exactly as written. Substring semantics
// would make `read` match `read_file` — convenient once, surprising forever.
func (h Hook) matches(tool string) bool {
	if h.Matcher == nil || h.MatcherSource == "" {
		return true
	}
	return h.Matcher.MatchString(tool)
}

// inputEnvelope is the JSON written to the hook's stdin.
//
// It is built here rather than marshalled by the caller so the truncation rule
// (fields, never the document) is applied in one place, and `truncated` is set by
// the same code that does the cutting.
func inputEnvelope(envelope Envelope) ([]byte, bool) {
	clipped, cut := envelope.clip()
	raw, err := json.Marshal(clipped)
	if err != nil {
		// A map that cannot marshal would be a bug in this package rather than in
		// the user's configuration; there is nothing to send, and the hook is
		// treated as failed by the caller.
		return nil, cut
	}
	return raw, cut
}

// runOne executes one hook and returns its parsed answer.
//
// Every failure mode of a child process has an outcome of its own, because the
// person reading the audit needs to tell "it timed out" from "it printed garbage"
// — the repairs are different.
func (s *Set) runOne(parent context.Context, hook Hook, envelope Envelope) (Output, Outcome) {
	started := time.Now()
	outcome := Outcome{Hook: hook.Name, Event: envelope.Event, Decision: DecisionNone,
		TimeoutMs: hook.TimeoutMs, Source: hook.Source, Tool: envelope.Tool.name()}

	payload, inputCut := inputEnvelope(envelope)
	if payload == nil {
		outcome.Status = StatusSpawn
		outcome.DurationMs = 0
		return Output{}, outcome
	}
	if inputCut {
		outcome.ReasonPreview = "the event was truncated before the hook saw it"
	}

	timeout := time.Duration(hook.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = time.Duration(DefaultTimeoutMs) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	stdout := newCappedBuffer(hook.MaxOutputBytes)
	stderr := newCappedBuffer(StderrLimitBytes)

	cmd := exec.CommandContext(ctx, hook.Argv[0], hook.Argv[1:]...)
	// The workspace root, so a relative path in a hook and a relative path in a
	// tool mean the same directory.
	cmd.Dir = envelope.Workspace
	cmd.Env = childEnv(envelope)
	cmd.Stdin = bytes.NewReader(payload)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	// Its own session/group (POSIX) or the process job object (Windows), so a hook
	// that starts children of its own can be collected as a tree. Without this a
	// timed-out hook leaks whatever it started — the exact failure
	// `internal/process` exists to prevent for background jobs.
	process.Isolate(cmd)

	if err := cmd.Start(); err != nil {
		outcome.Status = StatusSpawn
		outcome.DurationMs = int(time.Since(started).Milliseconds())
		outcome.ReasonPreview = previewText(err.Error(), 200)
		return Output{}, outcome
	}
	process.Attach(cmd)

	// The kill on overflow is what stops a runaway hook from filling memory before
	// the timeout arrives. It happens from the writer's goroutine, which is the
	// only place that knows the limit was crossed.
	var killOnce sync.Once
	kill := func() {
		killOnce.Do(func() { _ = process.TerminateTree(cmd) })
	}
	stdout.onOverflow = kill
	stderr.onOverflow = kill

	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()

	var waitErr error
	timedOut := false
	select {
	case waitErr = <-waited:
	case <-ctx.Done():
		// The tree goes first and the wait second: killing only the leader leaves
		// its children writing into a pipe nobody is reading, and `Wait` would
		// block on exactly those descriptors.
		_ = process.TerminateTree(cmd)
		<-waited
		timedOut = true
	}

	durationMs := int(time.Since(started).Milliseconds())
	outcome.DurationMs = durationMs
	outcome.StdoutBytes = stdout.Len()

	if timedOut {
		if parent.Err() != nil {
			// The turn itself was cancelled. Recording it as a timeout would blame
			// the hook for something a person did; the wording says what happened.
			outcome.Status = StatusTimeout
			outcome.Cancelled = true
			outcome.ReasonPreview = "the turn was interrupted while the hook was running"
			return Output{}, outcome
		}
		outcome.Status = StatusTimeout
		outcome.ReasonPreview = fmt.Sprintf("timed out after %dms", hook.TimeoutMs)
		return Output{}, outcome
	}
	if stdout.Overflow() {
		// Over the limit is a failure, never a truncate-then-parse: half a decision
		// is worse than no decision, and this is the one place where "we did our
		// best with what arrived" is the wrong instinct.
		outcome.Status = StatusTruncated
		outcome.ReasonPreview = fmt.Sprintf("the output exceeded %d bytes", hook.MaxOutputBytes)
		return Output{}, outcome
	}

	exitCode := 0
	if waitErr != nil {
		var exitErr *exec.ExitError
		if ok := asExitError(waitErr, &exitErr); ok {
			exitCode = exitErr.ExitCode()
		} else {
			outcome.Status = StatusExit
			outcome.ReasonPreview = previewText(waitErr.Error(), 200)
			return Output{}, outcome
		}
	}
	outcome.ExitCode = &exitCode

	// Exit 2 is "blocked": the stderr is the reason, and the stdout is irrelevant
	// — the convention every implementation in this space uses, which is why a
	// script written for one of them works here without translation.
	if exitCode == 2 {
		reason := strings.TrimSpace(stderr.String())
		reason, _, _ = clipRunes(reason, 2000)
		outcome.Decision = DecisionDeny
		outcome.Status = StatusDenied
		outcome.Reason = reason
		outcome.ReasonPreview = previewText(reason, 200)
		return Output{Decision: DecisionDeny, Reason: reason}, outcome
	}
	if exitCode != 0 {
		outcome.Status = StatusExit
		outcome.ReasonPreview = fmt.Sprintf("exited with %d: %s", exitCode,
			previewText(strings.TrimSpace(stderr.String()), 160))
		return Output{}, outcome
	}

	output, err := ParseOutput(stdout.Bytes(), envelope.Event)
	if err != nil {
		outcome.Status = StatusBadOutput
		outcome.ReasonPreview = previewText(err.Error(), 200)
		return Output{}, outcome
	}
	outcome.Status = StatusOK
	outcome.Decision = output.Decision
	if output.Reason != "" {
		outcome.Reason = output.Reason
		outcome.ReasonPreview = previewText(output.Reason, 200)
	}
	if output.Context != "" {
		outcome.ContextChars = len([]rune(output.Context))
	}
	if output.Decision == DecisionDeny {
		outcome.Status = StatusDenied
	}
	return output, outcome
}

// emitHookResult writes the audit row for one invocation.
//
// The body never travels: the reason is a 200-character preview and the injected
// context is only its length. That is the same rule the tool results and the
// memory recall follow, and the reason is the same — an audit log that copies
// conversations is a log nobody can hand to anybody.
func (s *Set) emitHookResult(outcome Outcome, envelope Envelope) {
	if s == nil || s.emit == nil {
		return
	}
	record := map[string]any{
		"kind":          audit.KindHookResult,
		"session_id":    envelope.SessionID,
		"run_id":        envelope.RunID,
		"step":          envelope.Step,
		"event":         string(envelope.Event),
		"hook":          outcome.Hook,
		"source":        outcome.Source,
		"status":        outcome.Status,
		"decision":      string(outcome.Decision),
		"duration_ms":   outcome.DurationMs,
		"stdout_bytes":  outcome.StdoutBytes,
		"context_chars": outcome.ContextChars,
		"updated_input": outcome.UpdatedInput,
	}
	// Only when something was actually taken away: a `restricted` list on every row
	// would be noise on the 99% of rows where nothing was narrowed.
	if len(outcome.Restricted) > 0 {
		record["restricted"] = outcome.Restricted
	}
	if outcome.ReasonPreview != "" {
		record["reason"] = outcome.ReasonPreview
	}
	if outcome.ExitCode != nil {
		record["exit_code"] = *outcome.ExitCode
	}
	// Taken from the outcome rather than from the envelope, so a short-circuited
	// hook's row (where no envelope was built for it) carries the same fields as one
	// that ran.
	if outcome.Tool != "" {
		record["tool"] = outcome.Tool
	}
	if envelope.Tool != nil && envelope.Tool.CallID != "" {
		record["call_id"] = envelope.Tool.CallID
	}
	if envelope.Subagent != nil {
		record["subagent_id"] = envelope.Subagent.ID
	}
	s.Emit(record)
}

// asExitError is errors.As for the one type the runner cares about.
//
// It is spelled out rather than inlined so the dependency on `errors` stays in one
// place and the runner's control flow reads as what it does.
func asExitError(err error, target **exec.ExitError) bool {
	return errors.As(err, target)
}

// failureReason names the failure in the words the model's sentence uses.
func failureReason(outcome Outcome) string {
	switch outcome.Status {
	case StatusTimeout:
		if outcome.TimeoutMs > 0 {
			return fmt.Sprintf("超时（>%dms）", outcome.TimeoutMs)
		}
		return "超时"
	case StatusTruncated:
		return "输出超上限"
	case StatusBadOutput:
		return "输出不是合法的决定"
	case StatusSpawn:
		return "启动失败"
	case StatusExit:
		return "异常退出"
	case StatusSkipped:
		return "被跳过"
	default:
		return "失败"
	}
}

// childEnv is the environment a hook runs with.
//
// A deliberate allowlist, and the reason is not paranoia about the hook: the hook
// is the user's own code and may read whatever it likes. What it must not be
// handed is the **configuration**, because that file holds API keys — and an
// environment is the one channel that would leak them without the hook ever
// asking.
func childEnv(envelope Envelope) []string {
	keep := []string{
		"PATH", "HOME", "USERPROFILE",
		"TMP", "TEMP", "TMPDIR",
		"SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC",
		"LANG", "LC_ALL", "PATHEXT",
	}
	var env []string
	for _, name := range keep {
		if value, present := os.LookupEnv(name); present && value != "" {
			env = append(env, name+"="+value)
		}
	}
	env = append(env,
		"TUDOUNI_HOOK_EVENT="+string(envelope.Event),
		"TUDOUNI_HOOK_NAME="+envelope.HookName,
		"TUDOUNI_WORKSPACE="+envelope.Workspace,
		"TUDOUNI_SESSION_ID="+envelope.SessionID,
	)
	if envelope.Mode != "" {
		env = append(env, "TUDOUNI_MODE="+envelope.Mode)
	}
	return env
}

// cappedBuffer collects output up to a limit and reports when more arrived.
//
// It keeps draining past the limit rather than failing the write: a child whose
// write returns an error gets SIGPIPE, and a hook that dies of SIGPIPE produces a
// much less useful report than one this program killed on purpose.
type cappedBuffer struct {
	mu         sync.Mutex
	buffer     bytes.Buffer
	limit      int
	overflow   bool
	onOverflow func()
}

func newCappedBuffer(limit int) *cappedBuffer {
	if limit <= 0 {
		limit = DefaultMaxOutputBytes
	}
	return &cappedBuffer{limit: limit}
}

func (c *cappedBuffer) Write(data []byte) (int, error) {
	c.mu.Lock()
	remaining := c.limit - c.buffer.Len()
	over := false
	if remaining <= 0 {
		c.overflow = true
		over = true
	} else if len(data) > remaining {
		c.buffer.Write(data[:remaining])
		c.overflow = true
		over = true
	} else {
		c.buffer.Write(data)
	}
	callback := c.onOverflow
	c.mu.Unlock()
	if over && callback != nil {
		callback()
	}
	return len(data), nil
}

func (c *cappedBuffer) Bytes() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]byte(nil), c.buffer.Bytes()...)
}

func (c *cappedBuffer) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buffer.String()
}

func (c *cappedBuffer) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buffer.Len()
}

func (c *cappedBuffer) Overflow() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.overflow
}

// args and name are nil-safe readers, because an event without a tool is the
// common case for most events.
func (t *ToolPayload) args() map[string]any {
	if t == nil {
		return nil
	}
	return t.Input
}

func (t *ToolPayload) name() string {
	if t == nil {
		return ""
	}
	return t.Name
}
