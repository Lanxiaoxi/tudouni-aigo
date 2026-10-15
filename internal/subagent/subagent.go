package subagent

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// Audit event kinds the delegation adds. They are the parent's own record of
// having delegated: the child's steps are in the child's log, and these two lines
// are what tie the two logs together when somebody reads a session afterwards.
const (
	KindDelegationStarted  = "delegation_started"
	KindDelegationFinished = "delegation_finished"

	// KindSubagentStarted reports **which route the child actually resolved to**.
	//
	// It exists because that fact is not visible anywhere else: the delegation's own
	// two lifecycle records carry the model, not the provider, and the status bar
	// shows the parent's route — so a child that ran somewhere else is a fact a
	// person can only learn from a log.
	//
	// It travels as an audit record rather than as a line on stderr because of where
	// this tool runs. The runtime is a child process of the front end, its stderr is
	// the terminal the front end is drawing on, and a delegated agent is by
	// definition something that happens while that screen is up — so a stderr line
	// here is a line written into a full-screen interface, erased by the next
	// redraw. The protocol layer turns this kind into a notice the interface can
	// draw; `--audit` reads the same record afterwards.
	KindSubagentStarted = "subagent_started"

	// KindSubagentProblem reports that the child's own session could not be written
	// down. It is the one failure of a delegation that leaves no other trace: the
	// parent still gets the child's answer, so nothing else on the parent's side
	// records that the child's transcript is gone.
	KindSubagentProblem = "subagent_problem"
)

// ChildOriginKey marks an audit record as having come from a delegated agent.
//
// It is a private convention between this package, the runtime and the protocol
// layer, and it never crosses the wire — the protocol turns it into `child` for a
// front end. It exists because the obvious discriminator does not work: the
// parent's own `tool_result` for a subagent call carries `subagent_id` too, so
// that a front end can connect the delegating call to the child it started.
// Classifying by that field would make the parent's own result look like a child's
// and drop the delegation's answer out of the transcript.
//
// The runtime sets it rather than the protocol layer deriving it, because
// recognising a child's id is a question about sessions, and the protocol layer
// deliberately knows nothing about what a session is.
const ChildOriginKey = "child_origin"

// Route is the child's model selection, as configured or as asked for.
//
// All three empty means "the same route as the parent", which is the default and
// the cheap answer: a delegation that silently moved to another model would make
// the session's cost and quality depend on which agent happened to answer.
type Route struct {
	Provider string
	Model    string
	Effort   string
}

// ChildChat is the client and the resolved route for one child.
type ChildChat struct {
	Chat     model.ChatModel
	Model    string
	Provider state.Provider
}

// RouteResolver turns a requested route into a usable client.
//
// It is an interface, and it is implemented by the runtime rather than here,
// because resolving a route means reading the model catalogue and knowing which
// keys are usable — composition, which this package deliberately does not do. It
// is also the only place a bad route is caught: returning an error refuses the
// delegation before a child session is created, so a misconfigured route is one
// failed tool call rather than a half-built agent.
type RouteResolver interface {
	// ResolveChild returns a chat client for the requested route. parentModel and
	// parentProvider are the delegating agent's current route, which is what an
	// empty request falls back to.
	ResolveChild(route Route, parentModel, parentProvider string) (ChildChat, error)
}

// Config is everything the tool needs from the runtime.
//
// Every field is injected rather than looked up, for the reason the rest of this
// program gives: the tool must not know where the workspace is, where sessions
// live, or how a chat client is built. Tests supply the same values with fakes.
type Config struct {
	// Chat is the delegating agent's client. It is read for its current model and
	// route name and never reused directly by a child.
	Chat model.ChatModel

	// Store is where the child's session is written. Nil turns persistence off —
	// the delegation still runs, and the child's history is lost when it ends.
	Store *state.SessionStore
	// Logs is the audit sink. The child's records go here under the child's own
	// session id.
	Logs *audit.JsonlSink

	// Catalog is the model catalogue, used for the child's context window.
	Catalog state.Registry
	// Resolver builds the child's client. Required.
	Resolver RouteResolver

	// Parent is the delegating session. Its id names the child and its metadata
	// carries the depth this delegation has to stay under.
	Parent *state.Session
	// Tools is the parent's registry. The child gets a copy without this tool.
	Tools *tools.Registry

	// Policy and Memory are the parent's permission layers, passed through so a
	// denied tool stays denied inside a child.
	Policy security.Policy
	Memory *security.Memory

	// Notes is the child's payload-tail builder. It is **not** the parent's:
	// see childNotes for what is deliberately withheld.
	Notes func() string
	// OnEvent receives the child's audit records, marked with its id.
	OnEvent func(record map[string]any)

	// Board is the runtime's tally of in-flight delegations, so a front end can
	// show that a subagent is running. Nil turns the announcement off — the
	// delegation still runs, and nothing on screen says so.
	Board *Board

	// ShouldStop is the parent's cancellation flag, consulted by the child.
	ShouldStop func() bool
	// Warn reports a diagnostic that the model does not need and a person does.
	Warn func(text string)

	// MaxDepth caps how deep delegation may go. Zero means no delegation at all,
	// which is also how a caller disables the feature: Build then returns no tool.
	MaxDepth int
	// MaxBackground caps the background delegations that may run at once. Zero
	// means DefaultMaxBackground; a negative value disables background
	// delegation — the argument is refused rather than ignored, so a model that
	// was taught the parameter is told why it never works.
	MaxBackground int
	// MaxSteps is the child's own step budget. Zero means the agent default.
	MaxSteps int
	// Name is the tool's name. Empty means DefaultToolName.
	Name string
	// Label is the short description shown for this delegation. It is not a
	// tool argument: see ToolArgs.Label.
	Label string

	// ChildProvider, ChildModel and ChildEffort are the route the child runs on.
	// Empty means the parent's own route, which is the default: a delegation that
	// silently moved to another model would make the cost and the quality of an
	// answer depend on which agent happened to produce it.
	ChildProvider string
	ChildModel    string
	ChildEffort   string

	// Thinking and Effort are the parent's reasoning settings, inherited by the
	// child so a delegation does not silently change how hard the model thinks.
	Thinking bool
	Effort   string
	// Debug turns on the child's step-by-step stderr trace.
	Debug bool
	// Clock is injected so durations are measurable in tests.
	Clock func() float64
}

// DefaultToolName is what the model sees when the runtime does not rename it.
const DefaultToolName = "subagent"

// DefaultMaxBackground caps the background delegations that may run at once.
//
// Depth caps nesting; this caps **width**. Each live background delegation is a
// whole agent loop burning tokens with nobody watching it, so a fan-out needs a
// bound of its own — and it is deliberately smaller than what a person watching
// the screen might allow, because the whole point of a background delegation is
// that nobody is watching.
const DefaultMaxBackground = 3

// ToolArgs is what the model may pass.
//
// `prompt` is required and there is no second required one, and that is the
// whole design of the interface: `prompt` has to be self-contained. A `context`
// parameter would be an invitation to paste half of the parent's history into
// it, which is the cost this feature exists to avoid — the subagent is a way to
// spend less context, not a way to move it around.
type ToolArgs struct {
	// Description is a short display label for the interfaces.
	Description string
	// Prompt is the complete, standalone task.
	Prompt string
	// Background asks for a delegation that outlives the turn: the call returns
	// immediately with the child's id, and the answer is collected later through
	// the collect tool. False — the default — keeps the foreground call, whose
	// result is the answer itself.
	Background bool
}

// Tool is the delegation tool.
//
// It is a struct rather than the `tools.Tool` the registry holds because the
// handler needs a home for its dependencies, and a closure capturing a dozen
// values is a closure nobody can test. Build turns one of these into the other.
type Tool struct {
	Config

	// childSeq numbers this session's delegations, in process memory. The atomic
	// is what lets two delegations mint their ids at the same time (one batch
	// runs them in different goroutines) without both landing on the same
	// number. The store's existence check is a different defence for a
	// different collision: see mintChildID.
	childSeq atomic.Int64

	// cancels holds one cancel function per running **background** delegation,
	// written before the goroutine starts and deleted when it settles. It is
	// what a per-child stop is built on: cancelling the child's own context
	// reaches its model calls and its shell commands through the same path a
	// foreground turn's Esc uses, but only the one child named.
	cancelsMu sync.Mutex
	cancels   map[string]context.CancelFunc
}

// callLabel is the description the interfaces show for this call.
//
// The label comes from the call's own arguments (see execute); `Config.Label`
// is only the fallback for a call the model supplied none. The tool itself
// holds no per-call state, because two calls may be in flight at once.
func (t *Tool) callLabel(label string) string {
	if label != "" {
		return label
	}
	return t.Config.Label
}

// Build returns the delegation tool, or false when delegation is disabled.
//
// A depth of zero means the tool is never registered rather than registered and
// always refusing. The distinction matters for the same reason it does everywhere
// else in this program: a tool the model can see but never use costs a round trip
// every time it is tried, and teaches it that tools lie.
func Build(config Config) (tools.Tool, bool) {
	_, built, ok := BuildWithHandle(config)
	return built, ok
}

// BuildWithHandle is Build with the concrete tool handed back alongside the
// registry-shaped value.
//
// The runtime keeps the concrete tool for exactly one thing: SubagentStop, the
// user's per-child stop, which is a runtime-level operation on the tool's cancel
// table rather than a model call. The generic tools.Tool value cannot carry that
// method, and a second construction path would be two tools to keep in sync — so
// one Build returns both shapes instead.
func BuildWithHandle(config Config) (*Tool, tools.Tool, bool) {
	if config.MaxDepth <= 0 {
		return nil, tools.Tool{}, false
	}
	if config.Resolver == nil {
		return nil, tools.Tool{}, false
	}
	if config.Name == "" {
		config.Name = DefaultToolName
	}
	if config.Clock == nil {
		config.Clock = security.PerfClock
	}
	tool := &Tool{Config: config, cancels: map[string]context.CancelFunc{}}

	maxBG := tool.maxBackground()
	if tool.backgroundDisabled() {
		maxBG = 0
	}

	built := tools.Tool{
		Name:        config.Name,
		Description: description(config.MaxDepth, maxBG),
		// High risk, and it is not a formality. This tool runs a whole agent,
		// which means it can run any other tool as many times as it likes; a
		// permission system that rated it low would be granting that entire
		// subtree on the strength of one approval.
		Risk: security.RiskHigh,
		Schema: tools.ObjectSchema(map[string]any{
			"description": tools.StringSchema(
				"这次委派要做什么，3–5 个词，只给界面显示用"),
			"prompt": tools.StringSchema(
				"子 agent 的完整任务。**它看不到这次对话** —— 它开在全新会话里，"+
					"所以要说清背景、目标、约束、验收标准，以及你已知的、它自己查不到的结论。"+
					"只写你真正需要的那一件事，不要写成一个大纲。",
				tools.MinLength(1)),
			"background": tools.BoolSchema(
				"true = 后台委派：调用立即返回子 agent 的 id，它跑它的，你继续你的回合；"+
					"完成后用收取工具取结果。只在你接下来的步骤**不依赖**这个结果时用；"+
					"默认 false（前台等待答复）。"),
		}, "prompt"),
		Handler: func(ctx context.Context, arguments map[string]any) (tools.Result, error) {
			return tool.execute(ctx, arguments)
		},
		// Parallel-safe because the handler holds nothing shared between
		// invocations: the label is read from the arguments, not from a field on
		// the tool, and the child id comes from an atomic counter. Two
		// delegations in one batch are the point of the feature — the parent
		// waits for the batch either way, so serial spawning buys nothing but
		// wall time. The cost of that wall time is still real: each child is a
		// whole agent loop, and the model is told in the description that
		// several at once is for independent tasks.
		ParallelSafe: true,
		// Not interactive, and the old value here was the bug: this handler
		// blocks for as long as a whole agent takes, but it never blocks on a
		// person answering — the child is built with no asker. "Long-running" is
		// not what Interactive means (the field's contract is "blocks on a
		// person"), and claiming it made the batch demote to serial.
		Interactive: false,
	}
	return tool, built, true
}

// execute is the handler.
func (t *Tool) execute(ctx context.Context, arguments map[string]any) (tools.Result, error) {
	prompt := strings.TrimSpace(stringArg(arguments, "prompt"))
	if prompt == "" {
		return tools.TextResult(
			"prompt 是空的：子 agent 看不到这次对话，你得把要做的事完整写进 prompt 里。"), nil
	}
	// The label is read from this call's arguments rather than stored on the
	// tool, because two invocations may be in flight at once: a shared field
	// would let one delegation hand its label to the other. It is display-only,
	// so it is never allowed to fail the call. It is also never allowed to
	// become the task: a model that put the real task in `description` and
	// nothing in `prompt` gets the refusal above, not a delegation of a
	// five-word label.
	var label string
	if raw := strings.TrimSpace(stringArg(arguments, "description")); raw != "" {
		label = clip(raw, 60)
	}
	// Background is opt-in per call. A non-bool never reaches here (the schema
	// validates it), so the zero value is genuinely "the argument was left out".
	background, _ := arguments["background"].(bool)

	if refusal := t.depthRefusal(); refusal != "" {
		return tools.TextResult(refusal), nil
	}
	if background {
		if refusal := t.backgroundRefusal(); refusal != "" {
			return tools.TextResult(refusal), nil
		}
	}
	return t.spawn(ctx, prompt, label, background)
}

// depthRefusal reports why this delegation is not allowed, or "" when it is.
//
// The check is made at call time rather than by hiding the tool, which matches
// how every other limit in this program behaves and has one concrete advantage: a
// visible tool that explains itself is a model that delegates something smaller,
// while a tool that vanishes is a model that reports the feature as missing.
func (t *Tool) depthRefusal() string {
	depth := DepthOf(t.Parent)
	if depth >= t.MaxDepth {
		return fmt.Sprintf(
			"不能再往下委派了：深度上限是 %d 层，你现在在第 %d 层。"+
				"把这件事自己做完；确实需要拆分的话，把结论写清楚交给上层。",
			t.MaxDepth, depth)
	}
	return ""
}

// maxBackground is the configured width cap, with the default applied.
func (t *Tool) maxBackground() int {
	if t.Config.MaxBackground == 0 {
		return DefaultMaxBackground
	}
	return t.Config.MaxBackground
}

// backgroundDisabled reports whether the negative MaxBackground marker is set.
func (t *Tool) backgroundDisabled() bool { return t.Config.MaxBackground < 0 }

// backgroundRefusal reports why a background delegation is not allowed, or ""
// when it is. The two refusals say different things on purpose: "off" is a
// configuration fact the model cannot work around, "at the cap" is a scheduling
// fact that changes when one of the running children settles.
func (t *Tool) backgroundRefusal() string {
	if t.backgroundDisabled() {
		return "后台委派没有启用（background 已被配置关闭）。请用前台委派等结果，或自己做这一步。"
	}
	if t.Board != nil && t.Board.BackgroundRunning() >= t.maxBackground() {
		return fmt.Sprintf(
			"后台委派已经到上限（%d 个在跑）。等其中一个完成并收取后再派，"+
				"或改用前台委派等结果。", t.maxBackground())
	}
	return ""
}

// storeCancel remembers one background delegation's cancel function, before the
// goroutine that will observe the cancellation starts. A stop that arrives in
// that window is exactly the one this ordering exists for.
func (t *Tool) storeCancel(childID string, cancel context.CancelFunc) {
	t.cancelsMu.Lock()
	defer t.cancelsMu.Unlock()
	t.cancels[childID] = cancel
}

// dropCancel forgets the entry once the delegation has settled: after that a
// Stop is answered "nothing running by that id", which is true.
func (t *Tool) dropCancel(childID string) {
	t.cancelsMu.Lock()
	defer t.cancelsMu.Unlock()
	delete(t.cancels, childID)
}

// Stop cancels one running background delegation by its child id.
//
// It is the runtime-facing seam for the user's per-child stop: the protocol's
// stop request lands here, and the cancellation reaches the child through its
// own context — the same path a foreground delegation's Esc takes, aimed at one
// child instead of the whole turn. It reports whether the id named a background
// delegation that was still running; anything else (foreground id, unknown id,
// already settled) is reported as not stopped rather than guessed at.
//
// A stopped child returns RunCancelled from its Run, so it settles with the
// ordinary "cancelled" stop reason and its partial output — the same shape a
// foreground interruption produces, and the same wording the parent already
// reads for one.
func (t *Tool) Stop(childID string) bool {
	t.cancelsMu.Lock()
	cancel, ok := t.cancels[childID]
	t.cancelsMu.Unlock()
	if !ok {
		return false
	}
	cancel()
	return true
}

// Result renders the child's answer for the parent's tool result.
//
// The shape is deliberately plain: a short header line, the child's own words,
// and — only when the delegation did not end cleanly — a line saying so. The
// parent reads this as fact and will act on it, so a failure must not be
// indistinguishable from an answer, and a success must not carry a wall of
// status text the parent will pay for on every later step.
func renderResult(t *Tool, childID string, answer string, runErr error, usage map[string]any) string {
	var b strings.Builder
	switch stopReasonOf(runErr, answer) {
	case "max_steps":
		fmt.Fprintf(&b, "子 agent %s 用完了步数（%d 步），没有收尾。下面是它已经产出的内容：\n\n",
			childID, t.MaxSteps)
	case "cancelled":
		fmt.Fprintf(&b, "子 agent %s 被中断了（用户停下了这一轮）。它已经产出的内容：\n\n", childID)
	case "model_fatal", "error":
		fmt.Fprintf(&b, "子 agent %s 执行失败：%s\n\n", childID, errorLine(runErr))
	case "no_output":
		fmt.Fprintf(&b, "子 agent %s 结束了，但没有给出任何内容。", childID)
	default:
		fmt.Fprintf(&b, "子 agent %s 的答复：\n\n", childID)
	}

	body := strings.TrimSpace(answer)
	if body == "" && runErr != nil {
		// Nothing was said, so say what is known instead of leaving an empty
		// result: an empty tool result reads as "it worked and there was nothing
		// to report", which is the opposite of what happened.
		body = "（子 agent 没有产出任何内容）"
	}
	b.WriteString(body)

	if line := usageLine(usage); line != "" {
		b.WriteString("\n\n" + line)
	}
	return b.String()
}

// usageLine is one sentence about what the child cost.
//
// It exists because delegation is the one operation whose cost is invisible from
// the parent's side: the token counts land in the child's log, and without this
// line the parent cannot tell a two-call delegation from a two-hundred-call one
// until the bill arrives.
func usageLine(usage map[string]any) string {
	if usage == nil {
		return ""
	}
	prompt := intOf(usage["prompt"])
	completion := intOf(usage["completion"])
	if prompt == 0 && completion == 0 {
		return ""
	}
	line := fmt.Sprintf("（子 agent 用量：输入 %s / 输出 %s token", number(prompt), number(completion))
	if calls := intOf(usage["model_calls"]); calls > 0 {
		line += fmt.Sprintf("，%d 次模型调用", calls)
	}
	if calls := intOf(usage["tool_calls"]); calls > 0 {
		line += fmt.Sprintf("，%d 次工具调用", calls)
	}
	return line + "）"
}

// errorLine turns an error into one line for the parent.
//
// The type name goes in as well as the message, because the two failure shapes
// the parent can actually act on look identical without it: a model error is
// "retry or change the task", a step limit is "delegate something smaller".
func errorLine(err error) string {
	if err == nil {
		return "未知原因"
	}
	text := strings.Join(strings.Fields(err.Error()), " ")
	return fmt.Sprintf("%T: %s", err, clip(text, 300))
}

// description writes the tool description the model reads every turn.
//
// Two things have to be in it and neither can wait for the system prompt, which
// is written once when a session is created: **it cannot see this conversation**
// (otherwise the model delegates "look at the file I just read" and the child
// finds nothing), and **it cannot ask questions** (otherwise the model waits for
// an answer that will never come). Both are facts about the child that the parent
// cannot discover by trying.
func description(maxDepth, maxBackground int) string {
	// The background paragraph is conditional because a tool description is a
	// promise: telling the model about a parameter the configuration disabled
	// is teaching it to make calls that always refuse.
	background := ""
	if maxBackground > 0 {
		background = fmt.Sprintf(`
前台与后台（background 参数，默认前台）：你的下一步**依赖**结果时，用前台——答复直接回到工具结果里，不需要第二次调用。你的下一步**不依赖**结果、而回合里还有别的事要做时，用 background=true：调用立即返回子 agent 的 id，它跑它的，你继续你的回合；它完成后，结果会出现在 payload 的「已完成待收取」段里，用收取工具带上 id 取回。后台委派同时最多 %d 个，到上限会拒绝并告诉你等哪一个。`, maxBackground)
	}
	return fmt.Sprintf(`把一个自足的任务交给子 agent 去做。它开在一个全新的会话里，**看不到这次对话**，所以 prompt 必须自带全部背景；它做完之后只把最终答复返回给你，中间过程留在它自己的上下文里 —— 这才是用它省钱的地方：翻找、试错、读大文件的开销不进你的上下文。

什么时候用：一段可以独立描述、结论比过程重要的活 —— 调研、定位、受范围限制的实现、对一份东西的审阅。什么时候不用：你自己一两次工具调用就能做完的事，或者还没想清楚要什么的事（那就先自己查清楚再决定要不要委派）。多个互相独立的子任务可以在同一轮里一起派：同一轮里的多个 subagent 调用会**并行**执行。有依赖关系的步骤要等上一轮的结果回来再派，不要在 prompt 里塞一串前后依赖的活儿。
%s
三条必须知道的限制：
1. **它看不到这次对话。** 凡是它自己查不到的信息（你的判断、已经确定的结论、刚读到的内容），都要写进 prompt。
2. **它没有审批通道：权限策略 deny list 里的工具会被拒绝，其余工具（含 shell、写文件）自动放行，不会问用户。** 不要指望它去问用户；把限制写进答复交还给你。它跑的时候没有人盯着，所以别把破坏性强的步骤（删数据、动生产）委派给它。
3. **它不能再往下委派，也碰不到父会话的待办、目标和技能。** 当前深度上限是 %d 层，子 agent 到顶之后只能自己做完；它有自己的会话，父会话的 todo、goal 和已加载技能对它既不显示也不可改。

它返回的是它的最终文本，不是它的中间步骤；失败、被中断或步数用尽时会明确标出来，并附上它已经产出的部分。`, background, maxDepth)
}

// delegationScopeMessage is the declaration the child gets in its own history.
//
// It is a user-role message rather than part of the system prompt because the
// system prompt is built by `state.NewSession` from the static prompt file, and
// this sentence is true only of a delegated agent. Putting it here also puts it
// **before the task**, which is where a reader of the child's transcript expects
// the conditions of the job to be.
func delegationScopeMessage() map[string]any {
	return map[string]any{
		"role": "user",
		"content": "在开始之前：你是一个被委派的子 agent，权限在你被启动时就固定了，" +
			"无法在本次会话里扩大。权限策略 deny list 里的工具会被直接拒绝，" +
			"其余工具（包括 shell 和写文件）会自动放行 —— 你这边没有人可以审批，" +
			"所以你的每一步都在无人盯着的情况下执行，不要做破坏性强的操作" +
			"（删数据、动生产、不可逆的变更），拿不准就把这条写进最终答复交还。" +
			"遇到被拒绝的操作不要重试，把这条限制写进你的最终答复里，" +
			"让委派你的那个 agent 去处理。" +
			"你还有自己的会话，所以父会话的待办清单、目标和已加载技能对你不可见，" +
			"也不要去改它们：把要交接的东西写进你的最终答复。",
		// Marked as a runtime note so it is never mistaken for the user's words by
		// anything that asks "what did the human actually ask for".
		state.RuntimeNoteKey: true,
	}
}

// --- small helpers ----------------------------------------------------------

func stringArg(args map[string]any, key string) string {
	value, _ := args[key].(string)
	return value
}

func intOf(value any) int {
	return intField(value)
}

// number renders a token count compactly. Decimals are kept only where they
// carry information, for the same reason the status bar does it.
func number(value int) string {
	switch {
	case value >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(value)/1_000_000)
	case value >= 1_000:
		return fmt.Sprintf("%.1fk", float64(value)/1_000)
	default:
		return fmt.Sprintf("%d", value)
	}
}

// clip bounds a string by runes, counting runes rather than bytes so a Chinese
// label is not cut in the middle of a character.
func clip(text string, limit int) string {
	runes := []rune(text)
	if limit <= 0 || len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}
