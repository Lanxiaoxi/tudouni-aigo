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
	// DebugPreviewLimit truncates the `--debug` previews on stderr. It is longer
	// than the audit's because it is read by a person watching a session rather
	// than skimmed later, and still bounded because a tool result can be megabytes.
	DebugPreviewLimit = 400
)

// presenceText renders "is there content" for the debug lines.
func presenceText(present bool) string {
	if present {
		return "有"
	}
	return "无"
}

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

// EmptyResponse means the model answered with nothing: no text and no tool call,
// only thinking, twice in a row. It is a distinct type rather than a model error
// because the session is intact and the model did not fail — it just did not
// speak, which is a different thing to tell a person.
type EmptyResponse struct {
	Step int
}

func (e *EmptyResponse) Error() string {
	return fmt.Sprintf("模型没有给出正文（%d 步，只有思考过程，也没有调用工具）。会话是完整的，可以换个说法再问一次。", e.Step+1)
}

// StopReason values, used in the run_finished event.
const (
	StopAnswered   = "answered"
	StopMaxSteps   = "max_steps"
	StopCancelled  = "cancelled"
	StopModelError = "model_error"
	StopModelFatal = "model_fatal"
	// StopEmptyResponse is a step that came back with nothing in it: no text and
	// no tool call, only thinking. It is **not** StopAnswered, and the difference
	// is the difference between "here is the answer" and "there is no answer" —
	// a header reading "Answered" above an empty turn is the one outcome a reader
	// cannot tell apart from a rendering bug, which is why it gets its own word.
	StopEmptyResponse = "empty_response"
)

// emptyNudge is what is added to the payload when a step came back empty.
//
// It is deliberately about the **interface**, not about the task: the model that
// produced this failure was mid-thought, not out of things to say, and a reminder
// about the work would only invite it to think again. What it cannot know from
// inside the reasoning channel is that the person sees none of it — that is the
// whole content of this message.
const emptyNudge = "上一轮你只产出了思考过程，没有给出正文，也没有调用任何工具 —— 用户看不到思考过程，" +
	"屏幕上什么都没有。请直接给出你要说的正文：需要继续做事就调用工具，否则把结论写出来。"

// emptyResponseRetries is how many times one turn may be nudged back to life.
//
// One, and the number is a policy rather than a tuning knob: the first retry
// converts "the gateway dropped the answer" (the common case) into a normal turn,
// while a second empty reply in a row means the endpoint is not going to answer
// this request at all. Retrying forever would turn a broken route into a session
// that burns steps and money producing nothing.
const emptyResponseRetries = 1

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
	// EffortLevels is the list the session's current model accepts. The audit
	// records it beside the level that was chosen, so a run can be read back as
	// "chose high out of these five" rather than only "chose high". It is passed
	// in because resolving it means reading the catalogue, which is assembly's
	// business; an empty list falls back to the broad vocabulary.
	EffortLevels []string

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
	//
	// The step is the **user-facing step number** (1-based), and it is passed
	// rather than inferred because this is the only end that knows it. A front end
	// uses it to tell one streaming block from the next: chunks of one step and of
	// the next travel the same channel with no other field to separate them, and a
	// block that cannot be told apart stops being updated. Deriving it from the
	// last recorded event instead is off by one exactly when the first step ends:
	// a step's `model_call` record is written **after** that step's chunks, and it
	// carries the loop's 0-based counter, so the second step's chunks come out with
	// the same number the first step's did.
	OnDelta func(step int, text, reasoning string, reset bool)
	// Notes returns text to append to the request payload only. It never enters
	// the session's message list: the task list and the background-job warning
	// belong to this run's working memory, not to the conversation.
	Notes func() string

	// BeforeEach runs before every model attempt, including the first, and it is
	// the hook for work that has to happen **at the moment of the request** rather
	// than when the turn began.
	//
	// The credential is the reason it exists: a token that expires mid-session is
	// still expired at the moment the request goes out, so knowing about it "when
	// the session started" is not enough. It is called in addition to the agent's
	// own stream reset, never instead of it.
	BeforeEach func()
	// OnFatal is offered a fatal error before it ends the call, and a true answer
	// means "the reason for it has been dealt with — send the request again".
	//
	// It exists for exactly one class of failure, and the narrowness is the point: a
	// fatal error is *final* by design, because repeating a bad request three times
	// only delays the report. A credential refusal is the exception, because the
	// thing that was wrong is not the request — it is what authenticated it, which
	// the caller may be able to replace. Supplying this hook is how a caller says it
	// has that ability; a nil hook means every fatal error is reported as before.
	//
	// It is consulted **once per call** by the agent that installs it, so a refusal
	// that survives the retry is reported rather than retried forever.
	OnFatal func(err error) bool

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

	// emptyNudged latches "this turn has already been told once that nothing was
	// visible". It is per turn (cleared when a turn starts) rather than per step,
	// because the thing being bounded is the turn's patience with a route that
	// returns nothing — see emptyResponseRetries.
	emptyNudged bool

	// compacting is the re-entrancy guard. The interface can ask for a manual
	// compaction from another goroutine while a turn is running, and two
	// summaries generated against two different boundaries would leave the
	// summary and the boundary disagreeing — the model would read a summary of a
	// stretch that is not the stretch it replaces.
	//
	// It is "try and skip" rather than a lock: compacting is not urgent, and
	// making the interface wait would freeze it.
	compacting bool

	// recoveredFatal is this turn's latch on OnFatal. It is what keeps "a credential
	// can be replaced" from turning into "a broken route is retried forever".
	recoveredFatal bool
}

// recoverFromFatal offers a fatal error to the configured hook, once per turn.
//
// **Once, and that is the whole design.** The hook exists because a credential
// refusal is the one fatal failure whose cause this program can remove without
// touching the request. It does not exist to make fatal errors retryable: a route
// that is wrong in any other way fails the same way every time, and a loop around
// it would produce three identical failures where one clear report belongs.
func (a *Agent) recoverFromFatal(err error) bool {
	if a.OnFatal == nil || a.recoveredFatal {
		return false
	}
	recovered := a.OnFatal(err)
	if recovered {
		a.recoveredFatal = true
	}
	return recovered
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

// OfferedEffortLevels is the list the audit records beside the chosen level.
//
// It reports the resolved list when assembly provided one, and the broad
// vocabulary otherwise. An empty list would read back as "this model takes no
// level", which is a claim nobody made.
func (a *Agent) OfferedEffortLevels() []string {
	if len(a.EffortLevels) == 0 {
		return state.BroadEffortLevels
	}
	return a.EffortLevels
}

// Run executes one turn and returns the answer.
func (a *Agent) Run(userInput string) (string, error) {
	return a.RunMessages([]map[string]any{{"role": "user", "content": userInput}})
}

// RunMessages executes one turn whose opening messages the runtime composed.
//
// It exists for the automatic goal round, whose opening message is not something a
// person typed: it is the runtime's own `<goal_round>` block, marked so nothing
// downstream reads it as user input. Everything else about the turn is identical to
// `Run` — and it has to be, which is why the two share this function instead of one
// calling the other with a synthesized string. A round that took a different path
// through the loop would be a second kind of turn, and the second kind is where the
// invariants get forgotten: paired tool calls, a checkpoint between whole steps, and
// compaction only at the top of the loop with the message list consistent.
//
// An empty list is refused rather than tolerated. A turn with no opening message
// asks the model to continue a conversation nobody started, and the answer would be
// indistinguishable from a real one.
func (a *Agent) RunMessages(messages []map[string]any) (string, error) {
	if len(messages) == 0 {
		return "", RunCancelled{}
	}

	a.runID = fmt.Sprintf("run-%d", time.Now().UnixNano())
	a.step = 0
	a.toolsUsed = a.toolsUsed[:0]
	a.startedAt = time.Now()
	// Per turn, not per session: the patience the empty guard spends is the turn's
	// own, so the next thing the user asks gets the nudge afresh. A session-wide
	// latch would make the second empty answer of a session — in a later turn,
	// after the route recovered — end the turn silently again.
	a.emptyNudged = false
	// Likewise per turn. "The credential was refreshed and the request sent again"
	// is a fact about one call, and a latch that survived the turn would silently
	// refuse to recover the next time the token really did expire.
	a.recoveredFatal = false

	// The note goes in before the user's message. It says "the earlier turns were
	// generated by X, from here on it is Y" — and it has to be in the history,
	// because after a change the model reads the earlier turns as its own and
	// continues in that style and at that quality.
	if a.Model != nil && a.Model.NoticeNeeded() {
		a.Session.Append(a.Model.Notice(""))
	}
	for _, message := range messages {
		a.Session.Append(message)
	}

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
		// Which levels were on offer for this turn's model, so the audit says what
		// the level was chosen *from* rather than only what was chosen.
		data["effort_levels"] = a.OfferedEffortLevels()
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

		a.debug(fmt.Sprintf("   ← 模型返回  content=%s  tool_calls=%d",
			presenceText(response.Content != nil && *response.Content != ""), len(response.ToolCalls)))
		if response.Content != nil && *response.Content != "" {
			a.debugLazy(func() string { return "      content: " + preview(*response.Content, DebugPreviewLimit) })
		}

		// The turn is over when there is no tool call — but "no tool call" is not
		// the same fact as "an answer". A thinking model can spend a whole step on
		// reasoning and return `content: null` with an empty tool list, and the
		// loop used to read that as StopAnswered with an empty answer: the header
		// said "Answered" over a blank turn, the session gained an assistant
		// message that said nothing, and the person was left with a question the
		// screen said had been answered.
		//
		// The message is **not** appended in that case, and that is the part worth
		// stating: the payload of the retry is then byte-identical to the payload
		// that failed (plus the nudge), so the prefix cache survives and the
		// session file does not gain a turn that never happened. An assistant
		// message with `content: null` and no calls is noise the next request has
		// to carry forever.
		if len(response.ToolCalls) == 0 {
			answer := ""
			if response.Content != nil {
				answer = *response.Content
			}
			if strings.TrimSpace(answer) == "" {
				if !a.emptyNudged {
					a.emptyNudged = true
					a.debug("   ⚠ 本轮没有正文，只有思考过程：已提示模型重新作答一次")
					continue
				}
				a.finish(StopEmptyResponse)
				return "", &EmptyResponse{Step: a.step}
			}
			a.Session.Append(assistantMessage(response))
			a.finish(StopAnswered)
			if a.OnCheckpoint != nil {
				a.OnCheckpoint()
			}
			return answer, nil
		}

		a.Session.Append(assistantMessage(response))

		// The tools of **this step**, not of the whole turn. The list is cleared at
		// the top of every step because it ends up in StepLimitExceeded, and that
		// message has one job: to say which tools the turn was stuck on. Accumulated
		// over 120 steps it is a hundred names and no clue.
		a.toolsUsed = a.toolsUsed[:0]
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
	if a.ShouldStop != nil {
		// Handed to the adapter as well: a stream in flight has to be dropped at
		// the next chunk, not at the next step boundary. See CompleteOptions.
		options.ShouldStop = a.ShouldStop
	}

	// The relay sends increments only when somebody is listening. A stream nobody
	// reads costs the same and delivers less, and whether `stream` appears in the
	// request body is itself observable in the audit.
	//
	// `a.step+1` is captured per call rather than read inside the closure: the
	// chunks of this call all belong to the step the loop is on **now**, and the
	// loop's counter moves on as soon as the step ends.
	step := a.step + 1
	if a.OnDelta != nil {
		options.OnDelta = func(text, reasoning string) { a.OnDelta(step, text, reasoning, false) }
		// Each attempt may restate the whole answer, so the copy already on the
		// screen is thrown away first. This is the interface half of delta_reset;
		// the audit half is emitted only when text actually went out.
		options.OnAttemptStarted = func() {}
	}

	var streamed bool
	// The two things that have to happen before an attempt, in one closure.
	//
	// They used to be one assignment each, and the second silently replaced the
	// first the moment a config hook existed — a `BeforeEach` that overwrites
	// another is how "the credential is refreshed" and "the half-written answer is
	// dropped" become alternatives, and the symptom would be a duplicate answer
	// after a retry, or a request sent with a key that is already dead.
	beforeAttempt := func() {
		if a.BeforeEach != nil {
			a.BeforeEach()
		}
		if streamed {
			if a.OnDelta != nil {
				a.OnDelta(step, "", "", true)
			}
			a.emit(audit.Event(audit.KindDeltaReset, a.Session.SessionID, a.runID, a.step, nil))
			streamed = false
		}
	}
	hooks := RetryHooks{
		ShouldStop: a.ShouldStop,
		BeforeEach: beforeAttempt,
		OnAttempt: func(attempt Attempt) {
			a.reportAttempt(attempt)
			if attempt.Status == "ok" && attempt.Response != nil && attempt.Response.StreamChunks > 0 {
				streamed = true
			}
		},
		OnFatal: a.recoverFromFatal,
	}

	relay := options.OnDelta
	if relay != nil {
		// Track that something was drawn, so a retry after a partial stream
		// announces the reset. A retry that streamed nothing leaves no reset in the
		// audit: recording one would claim the screen changed when it did not.
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
	if attempt.Status != "ok" {
		a.debug(fmt.Sprintf("   ↻ 模型调用失败（第 %d 次），准备重试", attempt.Number))
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
		// Why the endpoint stopped, in its own words. It is recorded **only when
		// the endpoint actually said**, so its absence is a finding rather than a
		// default: a step that came back with no text, no tool call, no usage and
		// no marker ended without the endpoint ever announcing an end — which is
		// the difference between "the model chose to stop" and "the gateway cut
		// the answer off", and it cannot be recovered after the fact.
		if response.FinishReason != "" {
			data["finish_reason"] = response.FinishReason
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
	// parallel says the batch this call belongs to ran together. It is recorded
	// on the result, because whether a batch runs in parallel is only known once
	// every call in it has been inspected — one tool that is not parallel-safe
	// demotes the whole batch — and the call event is written before that.
	parallel bool
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
// runBatch decides whether one step's calls can run together, and runs them.
//
// The parallel path prepares the **whole batch first** — parsed, looked up, approved
// — and only then executes. That order is what a concurrent batch needs: nothing may
// start before the last question has been answered, because a person's yes to the
// third call must not be given while the first two are already writing files.
//
// The serial path is the opposite on purpose: **report → decide → run → report, one
// call at a time**. A person asked about call *n+1* has to be able to see the result
// of call *n* first — that result is part of what they are judging with, and the
// previous generation states it as a rule. It also keeps the audit interleaved the
// way a reader expects: call, permission, result, call, permission, result.
func (a *Agent) runBatch(calls []model.ToolCall) error {
	batch := make([]prepared, 0, len(calls))
	parallel := len(calls) > 1

	for index, call := range calls {
		item := a.inspect(index, call)
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

	// The mode is a property of the whole batch, so it is written down only now
	// that nothing can change it. The audit's timing reads it from the results:
	// a parallel batch's per-call durations overlap, and a summary that took them
	// for serial work counted the batch twice.
	for i := range batch {
		batch[i].parallel = parallel
	}

	if parallel {
		for i := range batch {
			a.approve(&batch[i])
		}
		a.runParallel(batch)
		// A call that never ran still produced a result as far as the audit is
		// concerned: the model asked for it, and "it was refused" or "its arguments
		// were invalid" is the outcome. Recording only the executions would leave
		// the log showing a tool_call with nothing after it, which reads like a
		// crash.
		for i := range batch {
			if batch[i].failure != "" {
				a.reportToolResult(&batch[i], 0, false)
			}
		}
	} else {
		for i := range batch {
			// Adjacent, always: the question about this call comes after the
			// previous call's result has been shown.
			a.approve(&batch[i])
			a.runOne(&batch[i])
			if batch[i].failure != "" {
				a.reportToolResult(&batch[i], 0, false)
			}
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

// inspect resolves one call: which tool, which arguments, and whether they are even
// well formed. It reports the call so the log has the request even when nothing runs.
func (a *Agent) inspect(index int, call model.ToolCall) prepared {
	item := prepared{index: index, call: call, audit: map[string]any{}, status: statusOK}

	tool, known := a.Tools.Get(call.Name)
	if !known {
		a.reportToolCall(item)
		return failPrepared(item, statusInvalidArgs, "没有这个工具："+call.Name+"。请改用已注册的工具。")
	}
	item.tool = tool

	arguments := map[string]any{}
	if strings.TrimSpace(call.Arguments) != "" {
		if err := json.Unmarshal([]byte(call.Arguments), &arguments); err != nil {
			a.reportToolCall(item)
			return failPrepared(item, statusInvalidArgs, "参数不是合法 JSON："+err.Error())
		}
	}
	item.arguments = arguments
	a.reportToolCall(item)
	return item
}

// approve asks the permission gate and validates the arguments, in that order.
func (a *Agent) approve(item *prepared) {
	if item.failure != "" {
		return
	}
	// Permission. The verdict is recorded whether or not anybody was asked,
	// because "why did this not ask" is a question the log has to answer.
	verdict := security.Check(item.tool.Name, item.tool.Risk, item.arguments,
		a.Policy, a.Ask, a.Memory, a.Clock, a.autopilot)
	a.reportPermission(item.tool, item.arguments, verdict)

	if verdict.Denial != "" {
		*item = failPrepared(*item, "denied", verdict.Denial)
		return
	}

	// Validation runs before execution so a schema rejection is reported as
	// invalid arguments rather than as the tool failing to run — the model can fix
	// the first and cannot fix the second.
	if _, err := tools.Validate(item.tool.Parameters(), item.arguments); err != nil {
		*item = failPrepared(*item, statusInvalidArgs, "参数不合法："+err.Error())
	}
}

// failPrepared marks a call that will not run, with the text the model gets back.
func failPrepared(item prepared, kind, text string) prepared {
	item.failureKind = kind
	item.failure = text
	item.result = text
	item.status = kind
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
	if item.parallel {
		// The audit's timing has to tell a batch's overlapping durations from a
		// serial call's, or it adds them up and reports a turn that took longer
		// than it did. This is the only field it reads to do that, and until it
		// was written the whole "how much did running together save" figure was
		// dead: no result was ever marked, so every batch was measured as serial.
		data["parallel"] = true
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
	// Lazy, and this line is where the saving is largest: a tool result is routinely
	// hundreds of thousands of characters (read_file does not paginate), and
	// preview() scans the whole thing.
	a.debugLazy(func() string {
		return fmt.Sprintf("   ← 工具结果 (%d 字符): %s",
			len([]rune(item.result)), preview(item.result, DebugPreviewLimit))
	})
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

// reportToolCall records the request itself, before anything is known about
// whether it will run, or alongside what.
//
// It carries no `parallel` field on purpose. Whether a batch runs together is
// decided by the last call inspected — one tool that is not parallel-safe demotes
// the whole batch — and this event is written during inspection, while that
// answer is still moving. The result event carries it instead; see
// reportToolResult.
func (a *Agent) reportToolCall(item prepared) {
	data := map[string]any{
		"tool":       item.call.Name,
		"call_id":    item.call.ID,
		"tool_index": item.index,
		"arguments":  previewArguments(item.call.Arguments),
	}
	// Lazy: a `write_file` argument carries the whole file, and preview() walks it.
	a.debugLazy(func() string {
		return fmt.Sprintf("   → 工具调用 %s(%s)", item.call.Name,
			preview(item.call.Arguments, 120))
	})
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
	if prefix, ok := debugOutcomePrefix[result.Outcome]; ok {
		a.debug(prefix + " " + tool.Name)
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

func (a *Agent) reportToStderr(text string) { reportToStderrHook("[warn] " + text) }

// debug prints one line of the intermediate process to stderr.
//
// stderr and not stdout: the turn's answer is this program's output and can be
// piped somewhere, while what happened on the way is diagnostics. It is off unless
// `--debug` asked for it.
func (a *Agent) debug(text string) {
	if !a.Debug {
		return
	}
	reportToStderrHook("[debug] " + text)
}

// debugLazy is debug for a message that costs something to build.
//
// The cost is the reason it takes a function instead of a string, and the cost is
// real rather than theoretical: preview() walks the whole text to flatten newlines
// before truncating it, so a single 8 MB `read_file` result costs about 10ms of
// scanning — on every tool call, in every session, whether or not debug is on. With
// a closure, that scan only happens when somebody is going to read the line.
func (a *Agent) debugLazy(build func() string) {
	if !a.Debug {
		return
	}
	reportToStderrHook("[debug] " + build())
}

// preview flattens multi-line text into one line and marks the real length when it
// truncates. Flattening is lossless — a newline becomes a literal `\n` — so nothing
// can be hidden by it.
func preview(text string, limit int) string {
	flat := strings.ReplaceAll(text, "\n", "\\n")
	if limit <= 0 || len([]rune(flat)) <= limit {
		return flat
	}
	runes := []rune(flat)
	return string(runes[:limit]) + fmt.Sprintf("…(共 %d 字符)", len(runes))
}

// debugOutcomePrefix names each permission outcome for the debug line.
//
// Every route in and out is spelled out, because "why was this not asked about" is
// the question the line exists to answer and the outcome vocabulary is the answer.
var debugOutcomePrefix = map[string]string{
	security.OutcomeAutoAllowed:    "   ✓ 自动放行（等级在名单里）",
	security.OutcomeAutopilot:      "   ✓ 自动放行（autopilot）",
	security.OutcomeRuleAllowed:    "   ✓ 自动放行（按过 t）",
	security.OutcomeCommandAllowed: "   ✓ 自动放行（命中命令规则）",
	security.OutcomeApproved:       "   ✓ 用户批准",
	security.OutcomeUserDenied:     "   ✗ 用户拒绝",
	security.OutcomePolicyDenied:   "   ✗ 权限拒绝（策略禁止）",
	security.OutcomeNoAsker:        "   ✗ 需要审批但未配置 asker，按拒绝处理",
}
