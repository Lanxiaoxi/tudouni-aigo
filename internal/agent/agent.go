package agent

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/context"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// Constants governing one turn.
const (
	// DefaultMaxSteps is how many model round trips one turn may take.
	DefaultMaxSteps = 120
	// MaxParallel bounds a concurrent batch.
	MaxParallel = 8
	// AuditPreviewLimit truncates argument previews recorded in the audit. The
	// full text goes to the approval prompt, which is the thing a person needs to
	// decide; the audit only needs to say roughly what happened, and write_file
	// arguments can be megabytes.
	AuditPreviewLimit = 200
)

// RunCancelled means the user asked to stop this turn.
//
// It is a distinct type rather than a plain error so the session switch and the
// shutdown path can tell "the user interrupted" apart from "something broke" —
// they end the turn the same way but are reported differently.
type RunCancelled struct{}

func (RunCancelled) Error() string { return "this turn was interrupted" }

// StepLimitExceeded means the turn used up its budget.
//
// It is deliberately not a model error: the session is intact and the work can be
// continued, which is not true of a failed model call. It carries which tools the
// turn kept landing on, because that is the only clue about how to continue more
// cheaply.
type StepLimitExceeded struct {
	Step  int
	Tools []string
}

func (e *StepLimitExceeded) Error() string {
	return fmt.Sprintf("步数用尽（%d 步）。这一轮没有收尾，但会话是完整的 —— 接着跑就行。撞在：%s",
		e.Step, strings.Join(e.Tools, ", "))
}

// StopReason values, used in the run_finished event.
const (
	StopAnswered   = "answered"
	StopMaxSteps   = "max_steps"
	StopCancelled  = "cancelled"
	StopModelError = "model_error"
	StopModelFatal = "model_fatal"
)

// Config wires one Agent to everything outside it.
type Config struct {
	Chat  model.ChatModel
	Tools *tools.Registry
	// Policy is the coarse layer; Ask is how a human is reached. Ask may be nil,
	// which the gate turns into a refusal rather than a release.
	Policy security.Policy
	Ask    security.AskFunc
	Memory *security.Memory

	Session *state.Session
	// Model is the session-level choice; it supplies the change notice and the
	// thinking settings reported in the audit.
	Model *state.SessionModel

	MaxSteps  int
	Autopilot bool
	Debug     bool

	// OnCheckpoint persists the session. It is called only between whole steps.
	OnCheckpoint func()
	// OnEvent receives one audit record. It must never fail the turn; the two
	// callers (the JSONL sink and the protocol server) both swallow their own
	// errors, because observation must not be able to affect what is observed.
	OnEvent func(map[string]any)
	// OnDelta reports a stream increment. reset=true means "throw away what you
	// have drawn for this step".
	OnDelta func(text, reasoning string, reset bool)
	// Notes returns text to append to the request payload only. It never enters
	// the session's message list: the task list and the background-job warning
	// belong to this run's working memory, not to the conversation.
	Notes func() string

	ShouldStop func() bool
	Clock      func() float64

	// Context is the artifact store, budget and ledger for this session. It is
	// optional, and "no context" is a real state (tests, one-shot use): without
	// it, tool results stay inline in history and no artifact is written — the
	// behaviour from before the layer existed.
	//
	// It is injected rather than built here because the agent does not know where
	// the workspace is or what the session id is.
	Context *context.Manager
	// Processor turns one tool execution into artifacts. It travels with Context:
	// without a store to collect into, it has nowhere to put anything.
	Processor *context.ToolResultProcessor
}

// Agent runs one session's turns.
type Agent struct {
	Config

	// Autopilot is mutable: the running switch changes it for this session only,
	// while Config.Autopilot records what the process started with.
	autopilot bool

	runID     string
	step      int
	startedAt time.Time
	toolsUsed []string

	// compacting is the re-entrancy guard. The interface can ask for a manual
	// compaction from another goroutine while a turn is running, and two
	// summaries generated against two different boundaries would leave the
	// summary and the boundary disagreeing — the model would read a summary of a
	// stretch that is not the stretch it replaces.
	//
	// It is "try and skip" rather than a lock: compacting is not urgent, and
	// making the interface wait would freeze it.
	compacting bool
}

// New builds an agent.
func New(config Config) *Agent {
	if config.MaxSteps == 0 {
		config.MaxSteps = DefaultMaxSteps
	}
	if config.Clock == nil {
		config.Clock = security.PerfClock
	}
	return &Agent{Config: config, autopilot: config.Autopilot}
}

// SetAutopilot turns the "do not ask" switch on or off for this session.
//
// It is the running switch, which is a different thing from the process-level
// flag: the audit still tells the two apart, because the gate records
// `outcome=autopilot` either way and "was anybody watching" stays answerable.
func (a *Agent) SetAutopilot(on bool) { a.autopilot = on }

// Autopilot reports the running switch.
func (a *Agent) Autopilot() bool { return a.autopilot }

// Run executes one turn and returns the answer.
func (a *Agent) Run(userInput string) (string, error) {
	a.runID = fmt.Sprintf("run-%d", time.Now().UnixNano())
	a.step = 0
	a.toolsUsed = a.toolsUsed[:0]
	a.startedAt = time.Now()

	// The note goes in before the user's message. It says "the earlier turns were
	// generated by X, from here on it is Y" — and it has to be in the history,
	// because after a change the model reads the earlier turns as its own and
	// continues in that style and at that quality.
	if a.Model != nil && a.Model.NoticeNeeded() {
		a.Session.Append(a.Model.Notice(""))
	}
	a.Session.Append(map[string]any{"role": "user", "content": userInput})

	// The context is aligned with history before anything is written down, and
	// the order of these two steps matters:
	//
	//  1. MarkContextMessages gives the system prompt and the **first** user
	//     message their band and pinned flag — judged by position, which can only
	//     be computed with the whole history in hand;
	//  2. Session.Context points at the manager's state, because the write path
	//     reads the Session and must not know that a manager exists.
	//
	// Aligning before the checkpoint means the first write already carries the
	// full context state, so being killed mid-turn still restores to "what really
	// happened".
	if a.Context != nil {
		a.MarkContextMessages()
		a.Session.Context = a.Context.State
	}

	if a.OnCheckpoint != nil {
		a.OnCheckpoint()
	}

	if a.Model != nil {
		// Recorded before the request goes out, not after the answer arrives: the
		// sentence in the history stays true even when the model fails, and
		// recording it later would repeat the sentence on the next turn after a
		// failed one.
		a.Model.RecordUse()
	}

	a.emit(audit.Event(audit.KindRunStarted, a.Session.SessionID, a.runID, 0, a.runStartedData()))

	return a.loop()
}

func (a *Agent) runStartedData() map[string]any {
	data := map[string]any{
		"model":    a.Chat.ModelName(),
		"provider": a.Chat.ProviderName(),
	}
	if a.Model != nil {
		data["thinking"] = a.Model.Thinking()
		data["effort"] = a.Model.Effort()
		data["effort_levels"] = state.EffortLevels
	}
	return data
}

func (a *Agent) loop() (string, error) {
	for a.step = 0; a.step < a.MaxSteps; a.step++ {
		// The cancellation point sits between steps, which is the only place the
		// message list is consistent. Stopping anywhere else would leave an
		// assistant message with tool_calls and no results.
		if a.ShouldStop != nil && a.ShouldStop() {
			a.finish(StopCancelled)
			if a.OnCheckpoint != nil {
				a.OnCheckpoint()
			}
			return "", RunCancelled{}
		}

		// History compaction: the last resort before degradation.
		//
		// The position is the one place it cannot move from — the top of the
		// loop, after the previous step's tool results are all appended and the
		// checkpoint is written, so the message list is consistent. The summary
		// has to read exactly that, and the fold boundary has to cut on a whole
		// turn boundary.
		//
		// The test answers "is it time to consider it"; whether it can actually
		// be done is up to FoldPoint inside, which returns honestly when the
		// history is too short or folding would gain nothing.
		//
		// **The first step has to measure fresh.** LastEstimate was computed on
		// the previous step, and on this turn's first step it is still whatever
		// the previous Run left — which for a restored long session is zero, or a
		// number from before the last tool ran. So "over the line" could never be
		// true on the first step of a turn. The cost is one extra scan of the
		// history; what it buys is compacting immediately after reattaching to a
		// long session.
		//
		// A failed compaction never affects the turn: degradation still covers it.
		if a.Context != nil {
			over := a.Context.ShouldCompact()
			if !over && a.step == 0 {
				over = a.RefreshEstimate() && a.Context.ShouldCompact()
			}
			if over {
				a.compact(a.step+1, true)
			}
		}

		response, err := a.completeWithRetry()
		if err != nil {
			if isCancelled(err) {
				a.finish(StopCancelled)
				if a.OnCheckpoint != nil {
					a.OnCheckpoint()
				}
				return "", RunCancelled{}
			}
			reason := StopModelError
			if model.IsFatal(err) {
				reason = StopModelFatal
			}
			a.finish(reason)
			return "", err
		}

		// Calibrate the budget against the provider's measured input tokens.
		//
		// Here rather than at the end of the turn: response.Usage is the only
		// measurement available, and "should the next step degrade" depends on it.
		// Without it the estimator can only guess — and the direction of the
		// error decides the consequence: too high degrades for nothing, too low
		// fails the request.
		a.calibrate(response.Usage)

		assistant := assistantMessage(response)
		a.Session.Append(assistant)

		if len(response.ToolCalls) == 0 {
			answer := ""
			if response.Content != nil {
				answer = *response.Content
			}
			a.finish(StopAnswered)
			if a.OnCheckpoint != nil {
				a.OnCheckpoint()
			}
			return answer, nil
		}

		if err := a.runBatch(response.ToolCalls); err != nil {
			if isCancelled(err) {
				a.finish(StopCancelled)
				if a.OnCheckpoint != nil {
					a.OnCheckpoint()
				}
				return "", RunCancelled{}
			}
			return "", err
		}
		if a.OnCheckpoint != nil {
			a.OnCheckpoint()
		}
	}

	a.finish(StopMaxSteps)
	if a.OnCheckpoint != nil {
		a.OnCheckpoint()
	}
	return "", &StepLimitExceeded{Step: a.step, Tools: a.toolsUsed}
}

func (a *Agent) completeWithRetry() (model.ModelResponse, error) {
	payload := a.Payload()

	options := model.CompleteOptions{}

	// The relay sends increments only when somebody is listening. A stream nobody
	// reads costs the same and delivers less, and whether `stream` appears in the
	// request body is itself observable in the audit.
	if a.OnDelta != nil {
		options.OnDelta = func(text, reasoning string) { a.OnDelta(text, reasoning, false) }
		// Each attempt may restate the whole answer, so the copy already on the
		// screen is thrown away first. This is the interface half of delta_reset;
		// the audit half is emitted only when text actually went out.
		options.OnAttemptStarted = func() {}
	}

	var streamed bool
	hooks := RetryHooks{
		BeforeEach: func() {
			if streamed {
				if a.OnDelta != nil {
					a.OnDelta("", "", true)
				}
				a.emit(audit.Event(audit.KindDeltaReset, a.Session.SessionID, a.runID, a.step, nil))
				streamed = false
			}
		},
		OnAttempt: func(attempt Attempt) {
			a.reportAttempt(attempt)
			if attempt.Status == "ok" && attempt.Response != nil && attempt.Response.StreamChunks > 0 {
				streamed = true
			}
		},
	}

	relay := options.OnDelta
	if relay != nil {
		// Track that something was drawn, so a retry after a partial stream
		// announces the reset. A retry that streamed nothing leaves no reset in the
		// audit: recording one would claim the screen changed when it did not.
		hooks.BeforeEach = func() {
			if streamed {
				if a.OnDelta != nil {
					a.OnDelta("", "", true)
				}
				a.emit(audit.Event(audit.KindDeltaReset, a.Session.SessionID, a.runID, a.step, nil))
				streamed = false
			}
		}
		options.OnDelta = func(text, reasoning string) {
			if text != "" || reasoning != "" {
				streamed = true
			}
			relay(text, reasoning)
		}
	}

	return CallWithRetry(a.Chat, payload, a.toolSchemas(), options, hooks)
}

func (a *Agent) toolSchemas() []map[string]any {
	return a.Tools.Schemas()
}

func assistantMessage(response model.ModelResponse) map[string]any {
	message := map[string]any{"role": "assistant"}
	if response.Content != nil {
		message["content"] = *response.Content
	} else {
		message["content"] = nil
	}
	if len(response.ToolCalls) > 0 {
		calls := make([]any, 0, len(response.ToolCalls))
		for _, call := range response.ToolCalls {
			calls = append(calls, map[string]any{
				"id":   call.ID,
				"type": "function",
				"function": map[string]any{
					"name":      call.Name,
					"arguments": call.Arguments,
				},
			})
		}
		message["tool_calls"] = calls
	}
	return message
}

func (a *Agent) reportAttempt(attempt Attempt) {
	data := map[string]any{
		"attempt":     attempt.Number,
		"status":      attempt.Status,
		"duration_ms": attempt.DurationMs,
		"model":       a.Chat.ModelName(),
	}
	if attempt.Error != "" {
		data["error"] = firstN(attempt.Error, AuditPreviewLimit)
	}
	if attempt.BackoffMs != nil {
		data["backoff_ms"] = *attempt.BackoffMs
	}
	if response := attempt.Response; response != nil {
		data["tool_calls"] = len(response.ToolCalls)
		if response.Usage != nil {
			data["prompt_tokens"] = response.Usage.PromptTokens
			data["cached_tokens"] = response.Usage.CachedTokens
			data["miss_tokens"] = response.Usage.MissTokens()
			data["completion_tokens"] = response.Usage.CompletionTokens
		}
		// The stream summary, never the stream. Copying every chunk in would turn
		// the audit log into a second copy of the conversation and dilute "you can
		// replay this afterwards" into nothing.
		//
		// A turn that streamed no text carries no streamed key at all: reporting
		// `streamed: false` would suggest a stream was attempted.
		if response.StreamChunks > 0 {
			data["streamed"] = response.Streamed
			data["stream_chunks"] = response.StreamChunks
			data["streamed_chars"] = response.StreamedChars()
		}
		// The thinking text goes in whole and untruncated. It is the only
		// content-shaped field in the audit, and the interface folds it by default
		// — which is only possible if it is there in full.
		if response.Reasoning != nil && *response.Reasoning != "" {
			data["reasoning"] = *response.Reasoning
		}
	}
	a.emit(audit.Event(audit.KindModelCall, a.Session.SessionID, a.runID, a.step, data))
}

func (a *Agent) finish(reason string) {
	data := map[string]any{
		"stop_reason": reason,
		"duration_ms": int(time.Since(a.startedAt).Milliseconds()),
	}
	a.emit(audit.Event(audit.KindRunFinished, a.Session.SessionID, a.runID, a.step, data))
}

func (a *Agent) emit(record map[string]any) {
	if a.OnEvent == nil {
		return
	}
	// Swallowed on purpose. The caller of this function is sometimes holding a
	// half-written message list — an audit write that fails there must not turn
	// into a broken session, and observation must never be able to damage what it
	// observes.
	defer func() { _ = recover() }()
	a.OnEvent(record)
}

// prepared is one tool call after parsing, lookup, permission and validation.
type prepared struct {
	index     int
	call      model.ToolCall
	tool      tools.Tool
	arguments map[string]any
	// failure is set when the call cannot run; the text is what the model sees.
	failure     string
	failureKind string // "invalid_args" | "denied"
	status      string
	result      string
	audit       map[string]any
}

// runBatch executes every call the model asked for in one turn.
//
// The whole batch is prepared first — parsed, looked up, approved — and only then
// executed. Two consequences follow from that order, and both are wanted: the
// approvals happen on this goroutine in the model's order, so a person sees the
// questions in a predictable sequence; and nothing starts running before the last
// question has been answered.
func (a *Agent) runBatch(calls []model.ToolCall) error {
	batch := make([]prepared, 0, len(calls))
	parallel := len(calls) > 1

	for index, call := range calls {
		item := a.prepare(index, call)
		if item.tool.Name != "" {
			a.toolsUsed = append(a.toolsUsed, item.tool.Name)
			if !item.tool.ParallelSafe || item.tool.Interactive {
				parallel = false
			}
		} else {
			parallel = false
		}
		batch = append(batch, item)
	}

	if parallel {
		a.runParallel(batch)
	} else {
		for i := range batch {
			a.runOne(&batch[i])
		}
	}

	// A call that never ran still produced a result as far as the audit is
	// concerned: the model asked for it, and "it was refused" or "its arguments
	// were invalid" is the outcome. Recording only the executions would leave the
	// log showing a tool_call with nothing after it, which reads like a crash.
	for i := range batch {
		if batch[i].failure != "" {
			a.reportToolResult(&batch[i], 0, false)
		}
	}

	// Results are appended in the model's order regardless of the order they
	// finished in. The session must be reproducible: the same conversation run
	// twice has to produce byte-identical history, or the audit cannot be trusted.
	for i := range batch {
		a.Session.Append(a.toolMessage(&batch[i]))
	}
	return nil
}

func (a *Agent) prepare(index int, call model.ToolCall) prepared {
	item := prepared{index: index, call: call, audit: map[string]any{}, status: statusOK}

	fail := func(kind, text string) prepared {
		item.failureKind = kind
		item.failure = text
		item.result = text
		item.status = kind
		return item
	}

	tool, known := a.Tools.Get(call.Name)
	if !known {
		a.reportToolCall(item, false)
		return fail(statusInvalidArgs, "没有这个工具："+call.Name+"。请改用已注册的工具。")
	}
	item.tool = tool

	arguments := map[string]any{}
	if strings.TrimSpace(call.Arguments) != "" {
		if err := json.Unmarshal([]byte(call.Arguments), &arguments); err != nil {
			a.reportToolCall(item, false)
			return fail(statusInvalidArgs, "参数不是合法 JSON："+err.Error())
		}
	}
	item.arguments = arguments

	a.reportToolCall(item, false)

	// Permission. The verdict is recorded whether or not anybody was asked,
	// because "why did this not ask" is a question the log has to answer.
	verdict := security.Check(tool.Name, tool.Risk, arguments, a.Policy, a.Ask, a.Memory, a.Clock, a.autopilot)
	a.reportPermission(tool, arguments, verdict)

	if verdict.Denial != "" {
		return fail("denied", verdict.Denial)
	}

	// Validation runs before execution so a schema rejection is reported as
	// invalid arguments rather than as the tool failing to run — the model can fix
	// the first and cannot fix the second.
	if _, err := tools.Validate(tool.Parameters(), arguments); err != nil {
		return fail(statusInvalidArgs, "参数不合法："+err.Error())
	}
	return item
}

// runOne executes one prepared call.
func (a *Agent) runOne(item *prepared) {
	if item.failure != "" {
		return
	}
	started := time.Now()
	result, err := item.tool.Execute(item.arguments)
	durationMs := int(time.Since(started).Milliseconds())

	text := result.Text
	status := statusOK
	if err != nil {
		// A tool that fails unexpectedly reports a simplified sentence to the
		// model — a stack trace in the context helps nobody — while the trace
		// itself goes to stderr where the person running it can see it.
		status = statusError
		text = fmt.Sprintf("工具执行失败：%T: %v", err, err)
		a.reportToStderr(fmt.Sprintf("tool %s failed: %v", item.call.Name, err))
	}

	item.status = status
	if result.Audit != nil {
		for key, value := range result.Audit {
			item.audit[key] = value
		}
	}
	item.audit["chars"] = len([]rune(text))
	item.result = text

	a.reportToolResult(item, durationMs, status == statusOK)
}

func (a *Agent) reportToolResult(item *prepared, durationMs int, ok bool) {
	data := map[string]any{
		"tool":        item.call.Name,
		"call_id":     item.call.ID,
		"tool_index":  item.index,
		"status":      item.status,
		"chars":       len([]rune(item.result)),
		"duration_ms": durationMs,
	}
	// The tool's own audit fields are passed through: it knows things the agent
	// cannot derive (an exit code, how a question was answered, which skill action
	// happened), and they are what makes the log worth reading.
	for key, value := range item.audit {
		if _, taken := data[key]; taken {
			continue
		}
		data[key] = value
	}
	a.emit(audit.Event(audit.KindToolResult, a.Session.SessionID, a.runID, a.step, data))
}

func (a *Agent) runParallel(batch []prepared) {
	started := time.Now()
	semaphore := make(chan struct{}, MaxParallel)
	var wait sync.WaitGroup

	for i := range batch {
		if batch[i].failure != "" {
			continue
		}
		wait.Add(1)
		semaphore <- struct{}{}
		go func(item *prepared) {
			defer wait.Done()
			defer func() { <-semaphore }()
			a.runOne(item)
		}(&batch[i])
	}
	wait.Wait()

	names := make([]string, 0, len(batch))
	for _, item := range batch {
		names = append(names, item.call.Name)
	}
	// One event for the batch, recording the wall time rather than the sum of the
	// parts: adding the parts of a parallel batch would claim the turn took longer
	// than it did, and every later summary would inherit that.
	a.emit(audit.Event(audit.KindToolBatch, a.Session.SessionID, a.runID, a.step, map[string]any{
		"calls":   len(batch),
		"wall_ms": int(time.Since(started).Milliseconds()),
		"tools":   strings.Join(names, ","),
	}))
}

func (a *Agent) reportToolCall(item prepared, parallel bool) {
	data := map[string]any{
		"tool":       item.call.Name,
		"call_id":    item.call.ID,
		"tool_index": item.index,
		"arguments":  previewArguments(item.call.Arguments),
	}
	if parallel {
		data["parallel"] = true
	}
	a.emit(audit.Event(audit.KindToolCall, a.Session.SessionID, a.runID, a.step, data))
}

func (a *Agent) reportPermission(tool tools.Tool, arguments map[string]any, result security.Result) {
	data := map[string]any{
		"tool":      tool.Name,
		"risk":      string(tool.Risk),
		"decision":  string(result.Decision),
		"outcome":   result.Outcome,
		"arguments": previewArguments(mustJSON(arguments)),
		"parallel":  nil,
	}
	delete(data, "parallel")
	if result.WaitedMs != nil {
		data["waited_ms"] = *result.WaitedMs
	}
	if len(result.Remembered) > 0 {
		sort.Strings(result.Remembered)
		data["remembered"] = result.Remembered
	}
	if len(result.Rule) > 0 {
		formatted, err := security.FormatRule(result.Rule)
		if err == nil {
			data["rule"] = formatted
		}
	}
	a.emit(audit.Event(audit.KindPermission, a.Session.SessionID, a.runID, a.step, data))
}

func previewArguments(raw string) string {
	return firstN(raw, AuditPreviewLimit)
}

func firstN(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + fmt.Sprintf("…(共 %d 字符)", len(runes))
}

func mustJSON(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(raw)
}

func isCancelled(err error) bool {
	_, ok := err.(RunCancelled)
	return ok
}

const (
	statusOK          = "ok"
	statusInvalidArgs = "invalid_args"
	statusError       = "error"
	statusDenied      = "denied"
)

// toolMessage builds the message fed back to the model for one call.
//
// It is a method rather than a free function because the status and the text are
// two halves of the same fact, and letting a caller pass one without the other is
// how a denied call ends up looking like a successful one in the history.
//
// With a context, the body goes into the artifact store and the message carries
// only a reference; without one, the body stays inline, which is the behaviour
// from before the layer existed.
//
// **Not one tool_call_id may go missing.** The provider requires a result for
// every tool_calls entry, and a missing one is a 400 that reads like "context too
// long". So every path through here returns a complete tool message, including
// the one where storing the artifact failed.
func (a *Agent) toolMessage(item *prepared) map[string]any {
	inline := map[string]any{
		"role":         "tool",
		"tool_call_id": item.call.ID,
		"content":      item.result,
	}

	if a.Context == nil {
		return inline
	}

	processor := a.Processor
	if processor == nil {
		processor = context.DefaultProcessor()
	}

	execution := context.ToolExecution{
		Tool:      item.call.Name,
		Arguments: item.arguments,
		Text:      item.result,
		Audit:     item.audit,
		Status:    item.status,
	}
	artifacts, err := processor.Process(a.Context.Store, execution)
	if err != nil || len(artifacts) == 0 {
		// Falling back to inline text rather than to a reference: an artifact
		// that failed to store would leave history pointing at nothing, and the
		// model would never see this result again. Sending the body inline is
		// what happens without a context at all, so it is a known-good shape.
		if err != nil {
			a.reportToStderr(fmt.Sprintf("artifact store failed for %s: %v", item.call.Name, err))
		}
		return inline
	}

	artifact := artifacts[0]
	a.Context.Add(artifact.ID, context.AddOptions{Quiet: true})
	return map[string]any{
		"role":         "tool",
		"tool_call_id": item.call.ID,
		"content":      context.BuildReference(artifact.ID, artifact.Chars, item.call.Name),
		// The explicit id field: a program should not be finding an artifact by
		// parsing a sentence meant for a person.
		"artifact_id": artifact.ID,
	}
}

// reportToStderr prints a diagnostic a person needs but the model does not. It is
// injected so this package stays free of a direct dependency on stderr.
var reportToStderrHook = func(string) {}

// SetStderrSink points the diagnostic sink somewhere visible.
func SetStderrSink(sink func(string)) {
	if sink != nil {
		reportToStderrHook = sink
	}
}

func (a *Agent) reportToStderr(text string) { reportToStderrHook(text) }
